const http = require("http");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const { URL } = require("url");

const rootDir = path.resolve(__dirname, "..");
const publicDir = path.join(rootDir, "public");
const dataDir = path.join(rootDir, "data");
const dataFile = path.join(dataDir, "cadastros.ndjson");
const { loadEnvironment, getSupabaseConfig, supabaseHeaders } = require("./supabase-config");
loadEnvironment(rootDir);
const supabaseConfig = getSupabaseConfig();

const PORT = Number(process.env.PORT || 3000);
const SUPABASE_URL = supabaseConfig.url;
const SUPABASE_ANON_KEY = supabaseConfig.publishableKey;
const SUPABASE_SERVICE_ROLE_KEY = supabaseConfig.secretKey;

// Compatibility for existing internal handlers; credentials come only from the environment.
process.env.SUPABASE_URL = SUPABASE_URL;
process.env.SUPABASE_ANON_KEY = SUPABASE_ANON_KEY;
process.env.SUPABASE_SERVICE_ROLE_KEY = SUPABASE_SERVICE_ROLE_KEY;

const SUPABASE_TABLE_CADASTROS = process.env.SUPABASE_TABLE_CADASTROS || "";
const SUPABASE_TABLE_CRIANCA = process.env.SUPABASE_TABLE_CRIANCA || "ebi_criancas";
const SUPABASE_TABLE_MONITOR = process.env.SUPABASE_TABLE_MONITOR || "ebi_monitores";
const SUPABASE_TABLE_RECITATIVOS = process.env.SUPABASE_TABLE_RECITATIVOS || "ebi_atividades";
const WEBHOOK_RECITATIVOS = process.env.WEBHOOK_RECITATIVOS || "";
const REQUIRE_SUPABASE_DUPLICATE_CHECK = (process.env.REQUIRE_SUPABASE_DUPLICATE_CHECK || "true").toLowerCase() !== "false";
const ENABLE_LOCAL_PERSISTENCE = (process.env.ENABLE_LOCAL_PERSISTENCE || "false").toLowerCase() === "true";
const REQUIRE_LOCAL_DUPLICATE_CHECK = (process.env.REQUIRE_LOCAL_DUPLICATE_CHECK || "false").toLowerCase() === "true";

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon"
};

function sendJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;

  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1_000_000) throw new Error("payload_too_large");
    chunks.push(chunk);
  }

  const raw = Buffer.concat(chunks).toString("utf-8");
  if (!raw) return {};
  return JSON.parse(raw);
}

async function saveSubmission(tipo, payload) {
  const id = crypto.randomUUID();
  const entry = {
    id,
    uuid: id,
    tipo,
    createdAt: new Date().toISOString(),
    payload,
    persistedLocally: false
  };

  if (!ENABLE_LOCAL_PERSISTENCE) return entry;

  // Vercel serverless pode ter filesystem somente leitura.
  try {
    await fsp.mkdir(dataDir, { recursive: true });
    await fsp.appendFile(dataFile, JSON.stringify(entry) + "\n", "utf-8");
    entry.persistedLocally = true;
  } catch {
    entry.persistedLocally = false;
  }

  return entry;
}

async function readLocalEntries() {
  if (!REQUIRE_LOCAL_DUPLICATE_CHECK) return [];

  try {
    const content = await fsp.readFile(dataFile, "utf-8");
    return content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        try {
          const parsed = JSON.parse(line);
          if (!parsed || typeof parsed !== "object") return null;
          return {
            id: parsed.uuid || parsed.id || "",
            tipo: parsed.tipo || "",
            payload: parsed.payload || {},
            createdAt: parsed.createdAt || parsed.created_at || ""
          };
        } catch {
          return null;
        }
      })
      .filter((entry) => entry && entry.tipo && entry.payload);
  } catch {
    return [];
  }
}

function normalizeText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function onlyDigits(value) {
  return String(value || "").replace(/\D/g, "");
}

function isEmailFieldName(fieldName) {
  if (!fieldName) return false;
  const normalized = String(fieldName).toLowerCase();
  return normalized === "email" || normalized.endsWith("_email");
}

function toUppercaseDeep(value, fieldName = "") {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (isEmailFieldName(fieldName)) return trimmed;
    return trimmed.toUpperCase();
  }
  if (Array.isArray(value)) return value.map((item) => toUppercaseDeep(item, fieldName));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entryValue]) => [key, toUppercaseDeep(entryValue, key)])
    );
  }
  return value;
}

function normalizeDate(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";

  const slash = raw.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (slash) return `${slash[3]}-${slash[2]}-${slash[1]}`;

  const dash = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (dash) return raw;

  return normalizeText(raw);
}

function nameTokens(value) {
  const stopWords = new Set(["de", "da", "do", "dos", "das", "e"]);
  return new Set(
    normalizeText(value)
      .split(" ")
      .filter((token) => token && !stopWords.has(token))
  );
}

function tokenSimilarity(a, b) {
  const tokensA = nameTokens(a);
  const tokensB = nameTokens(b);
  if (tokensA.size === 0 || tokensB.size === 0) return 0;

  let intersection = 0;
  for (const token of tokensA) {
    if (tokensB.has(token)) intersection += 1;
  }

  return intersection / Math.max(tokensA.size, tokensB.size);
}

function namesLookSame(a, b) {
  const normalizedA = normalizeText(a);
  const normalizedB = normalizeText(b);
  if (!normalizedA || !normalizedB) return false;
  if (normalizedA === normalizedB) return true;
  if (normalizedA.includes(normalizedB) || normalizedB.includes(normalizedA)) return true;
  return tokenSimilarity(normalizedA, normalizedB) >= 0.6;
}

function formatDateTimeBR(value) {
  const dateObj = value ? new Date(value) : null;
  if (!dateObj || Number.isNaN(dateObj.getTime())) {
    return { date: "--/--/----", time: "--:--:--" };
  }

  return {
    date: dateObj.toLocaleDateString("pt-BR"),
    time: dateObj.toLocaleTimeString("pt-BR", { hour12: false })
  };
}

function formatDateBR(value) {
  const normalized = normalizeDate(value);
  const match = normalized.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return String(value || "").trim() || "--/--/----";
  return `${match[3]}/${match[2]}/${match[1]}`;
}

function getRecitativoComum(payload = {}) {
  return String(payload.localidade || payload.comum || payload.comum_congregacao || "").trim();
}

function getRecitativoMunicipio(payload = {}) {
  return String(payload.cidade || payload.municipio || "").trim();
}

function buildRecitativoDuplicateDetails(entry) {
  const existing = entry?.payload || {};

  return {
    comum: getRecitativoComum(existing) || "Comum não informada",
    municipio: getRecitativoMunicipio(existing) || "Município não informado",
    dataReuniao: formatDateBR(existing.data_reuniao),
    createdAt: entry?.createdAt || existing.created_at || existing.createdAt || ""
  };
}

async function readSavedRecitativosByDate(dateValue) {
  const normalizedDate = normalizeDate(dateValue);
  const localEntries = (await readLocalEntries()).filter((entry) => (
    entry.tipo === "recitativo" &&
    normalizeDate(entry.payload?.data_reuniao) === normalizedDate
  ));

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return localEntries;
  }

  const table = process.env.SUPABASE_TABLE_RECITATIVOS || "ebi_atividades";
  const candidateDates = [...new Set([normalizedDate, formatDateBR(normalizedDate)].filter(Boolean))];
  const remoteEntries = [];

  for (const candidateDate of [normalizedDate]) {
    if (!candidateDate) continue;
    const url = new URL(`${SUPABASE_URL.replace(/\/$/, "")}/rest/v1/${table}`);
    url.searchParams.set("select", "*");
    url.searchParams.set("data_reuniao", `eq.${candidateDate}`);
    url.searchParams.set("limit", "200");

    const response = await fetch(url, {
      method: "GET",
      headers: {
        ...supabaseHeaders(SUPABASE_SERVICE_ROLE_KEY)
      }
    });

    if (!response.ok) {
      const bodyText = await response.text();
      console.error(`[DEBUG] Supabase Duplicate Check Error - Table: ${table}, Status: ${response.status}, Body: ${bodyText}`);
      throw new Error(`supabase_recitativo_duplicate_check_failed:${response.status}:${bodyText}`);
    }

    const rows = await response.json();
    for (const row of rows) {
      remoteEntries.push({
        id: row.id || "",
        tipo: "recitativo",
        payload: row,
        createdAt: row.created_at || row.createdAt || ""
      });
    }
  }

  const deduped = new Map();
  for (const entry of [...remoteEntries, ...localEntries]) {
    const key = `${entry.id}::${JSON.stringify(entry.payload || {})}`;
    if (!deduped.has(key)) deduped.set(key, entry);
  }

  return [...deduped.values()];
}

function detectRecitativoDuplicate(payload, entries) {
  const common = normalizeText(getRecitativoComum(payload));
  const meetingDate = normalizeDate(payload.data_reuniao);
  if (!common || !meetingDate) return { duplicate: false };

  for (const entry of entries) {
    const existing = entry.payload || {};
    const existingCommon = normalizeText(getRecitativoComum(existing));
    const existingMeetingDate = normalizeDate(existing.data_reuniao);

    if (common === existingCommon && meetingDate === existingMeetingDate) {
      return {
        duplicate: true,
        matchedId: entry.id,
        reason: "comum_e_data",
        matchedEntry: entry
      };
    }
  }

  return { duplicate: false };
}

async function verifySupabaseToken(authHeader) {
  if (!authHeader || !authHeader.startsWith("Bearer ")) return null;
  const token = authHeader.split(" ")[1];

  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    console.error("SUPABASE_URL ou SUPABASE_ANON_KEY ausentes para validar token.");
    return null;
  }

  try {
    const url = new URL(`${SUPABASE_URL.replace(/\/$/, "")}/auth/v1/user`);
    const response = await fetch(url, {
      method: "GET",
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${token}`
      }
    });

    if (!response.ok) return null;
    return await response.json();
  } catch (err) {
    console.error("Erro ao validar token do Supabase:", err);
    return null;
  }
}

async function getUserProfile(userId, email = null) {
  if (!userId || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return null;

  const auxTable = process.env.SUPABASE_TABLE_AUXILIARES || "profiles";
  const tables = [...new Set(["profiles", auxTable])];

  for (const table of tables) {
    try {
      // 1. Tenta buscar por 'id'
      const urlId = new URL(`${SUPABASE_URL.replace(/\/$/, "")}/rest/v1/${table}?id=eq.${userId}&select=*`);
      const resId = await fetch(urlId, {
        headers: { ...supabaseHeaders(SUPABASE_SERVICE_ROLE_KEY) }
      });
      if (resId.ok) {
        const dataId = await resId.json();
        if (Array.isArray(dataId) && dataId.length > 0) return dataId[0];
      }

      // 2. Tenta buscar por 'user_id'
      const urlUserId = new URL(`${SUPABASE_URL.replace(/\/$/, "")}/rest/v1/${table}?user_id=eq.${userId}&select=*`);
      const resUserId = await fetch(urlUserId, {
        headers: { ...supabaseHeaders(SUPABASE_SERVICE_ROLE_KEY) }
      });
      if (resUserId.ok) {
        const dataUserId = await resUserId.json();
        if (Array.isArray(dataUserId) && dataUserId.length > 0) return dataUserId[0];
      }

      // 3. Tenta buscar por 'email'
      if (email) {
        const urlEmail = new URL(`${SUPABASE_URL.replace(/\/$/, "")}/rest/v1/${table}?email=eq.${email}&select=*`);
        const resEmail = await fetch(urlEmail, {
          headers: { ...supabaseHeaders(SUPABASE_SERVICE_ROLE_KEY) }
        });
        if (resEmail.ok) {
          const dataEmail = await resEmail.json();
          if (Array.isArray(dataEmail) && dataEmail.length > 0) return dataEmail[0];
        }
      }
    } catch (err) {
      console.warn(`Erro ao buscar perfil na tabela ${table}:`, err.message);
    }
  }

  return null;
}

async function serveStatic(reqPath, res) {
  const normalized = path.normalize(reqPath).replace(/^([.][.][/\\])+/, "");
  const filePath = path.join(publicDir, normalized);

  if (!filePath.startsWith(publicDir)) {
    sendJson(res, 403, { error: "Acesso negado." });
    return;
  }

  let stat;
  try {
    stat = await fsp.stat(filePath);
  } catch {
    sendJson(res, 404, { error: "Arquivo não encontrado." });
    return;
  }

  if (stat.isDirectory()) {
    sendJson(res, 404, { error: "Arquivo não encontrado." });
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  const contentType = mimeTypes[ext] || "application/octet-stream";

  res.writeHead(200, {
    "Content-Type": contentType,
    "Cache-Control": "no-store, no-cache, must-revalidate",
    Pragma: "no-cache",
    Expires: "0"
  });
  fs.createReadStream(filePath).pipe(res);
}

function routeToPage(rawPathname) {
  const pathname = rawPathname.replace(/\/$/, "") || "/";
  const p = pathname.toLowerCase();

  if (p === "/") return "index.html";
  if (p === "/login.html" || p === "/login") return "login.html";
  if (p === "/registro.html" || p === "/registro") return "registro.html";
  if (p === "/privacidade.html" || p === "/privacidade") return "privacidade.html";
  if (p === "/cadastro.html" || p === "/cadastro") return "cadastro.html";
  if (p === "/cadastro/crianca") return "cadastro.html";
  if (p === "/cadastro/monitor") return "cadastro.html";
  return null;
}

async function handleRequest(req, res) {
  const host = req.headers.host || "localhost";
  const url = new URL(req.url, `http://${host}`);
  const pathname = url.pathname;
  
  // Log de Debug para resolver erro de rota
  console.log(`[Server] ${req.method} ${pathname}`);

  try {
    const p = pathname.toLowerCase().replace(/\/$/, "") || "/";

    // --- ROTA DE LANÇAMENTO (POST) - Prioridade Máxima para Produção ---
    if (req.method === "POST" && p === "/api/atividades") {
      const authUser = await verifySupabaseToken(req.headers.authorization);
      if (!authUser) {
        return sendJson(res, 401, { error: "Não autorizado. Faça login novamente." });
      }

      const profile = await getUserProfile(authUser.id);
      if (!profile) {
        return sendJson(res, 403, { error: "Acesso negado: Perfil de usuário não encontrado." });
      }

      // Check role authorization (Allowed: Master/1, Admin/2, Coordenador/3, Instrutor/4)
      const allowedRoles = [1, 2, 3, 4];
      const userRoleId = parseInt(profile.role_id || profile.nivel || 6, 10);
      if (!allowedRoles.includes(userRoleId)) {
        return sendJson(res, 403, { 
          error: "Acesso negado: seu nível de acesso não permite fazer lançamentos nesta aplicação.",
          role_id: userRoleId
        });
      }

      const payload = await readJsonBody(req);
      console.log("[DEBUG] Recebendo Payload no Servidor:", JSON.stringify(payload, null, 2));
      const missing = ["data_reuniao", "localidade"].filter((field) => {
        const value = payload[field];
        return value === undefined || value === null || String(value).trim() === "";
      });

      if (missing.length > 0) {
        return sendJson(res, 400, { error: "Campos obrigatórios ausentes.", missing });
      }

      const existingRecitativos = await readSavedRecitativosByDate(payload.data_reuniao);
      const duplicateCheck = detectRecitativoDuplicate(payload, existingRecitativos);
      if (duplicateCheck.duplicate) {
        return sendJson(res, 409, {
          error: "Esta Comum já realizou um lançamento nesta data. Procure a coordenação.",
          duplicateOf: duplicateCheck.matchedId,
          duplicateReason: duplicateCheck.reason,
          duplicate: buildRecitativoDuplicateDetails(duplicateCheck.matchedEntry)
        });
      }

      // Salvar localmente
      const saved = await saveSubmission("recitativo", payload);

      // Salvar no Supabase
      const supabaseUrl = process.env.SUPABASE_URL;
      const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
      const supabaseTable = process.env.SUPABASE_TABLE_RECITATIVOS || "ebi_atividades";

      if (supabaseUrl && supabaseKey) {
        const url = new URL(`${supabaseUrl.replace(/\/$/, "")}/rest/v1/${supabaseTable}`);
        try {
          const resSupabase = await fetch(url, {
            method: "POST",
            headers: {
              ...supabaseHeaders(supabaseKey),
              "Content-Type": "application/json",
              "Prefer": "return=minimal"
            },
            body: JSON.stringify(payload)
          });
          
          if (!resSupabase.ok) {
            const errorText = await resSupabase.text();
            console.error("Erro no Supabase:", errorText);
            return sendJson(res, 500, { error: "Erro ao salvar no banco de dados Supabase.", details: errorText });
          }
        } catch (err) {
          console.error("Falha ao conectar com Supabase:", err);
          return sendJson(res, 500, { error: "Falha de conexão com Supabase." });
        }
      }

      // Webhook opcional
      const webhookUrl = process.env.WEBHOOK_RECITATIVOS;
      if (webhookUrl) {
        try {
          await fetch(webhookUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ 
              ...payload, 
              spreadsheet_id: process.env.GOOGLE_SHEET_ID_RECITATIVOS,
              id: saved.id, 
              created_at: saved.createdAt 
            })
          });
        } catch (err) {
          console.error("Erro no Webhook:", err);
        }
      }

      return sendJson(res, 201, { message: "Lançamento realizado com sucesso.", id: saved.id });
    }

    // --- ROTA DE PERFIL (GET/POST) ---
      if (p === "/api/profile") {
        const supabaseUrl = process.env.SUPABASE_URL;
        const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

        if (req.method === "GET") {
          const userId = url.searchParams.get("id");
          const userEmail = url.searchParams.get("email");
          if (!userId) return sendJson(res, 400, { error: "ID do usuário ausente." });
          
          const profile = await getUserProfile(userId, userEmail);
          return sendJson(res, 200, profile || {});
        }

      if (req.method === "POST") {
        let body = "";
        req.on("data", chunk => body += chunk);
        req.on("end", async () => {
          try {
            const profileData = JSON.parse(body);
            console.log("Recebido /api/profile (POST):", profileData);
            if (!profileData.id) return sendJson(res, 400, { error: "ID do usuário obrigatório." });

            const table = process.env.SUPABASE_TABLE_AUXILIARES || 'profiles';

            // Map payload columns to match table schemas dynamically
            const mappedData = { ...profileData };
            if (table === "profiles") {
              if (mappedData.id && !mappedData.user_id) {
                mappedData.user_id = mappedData.id;
              }
              delete mappedData.id;
            } else if (table === "rjm_auxiliares") {
              if (mappedData.user_id && !mappedData.id) {
                mappedData.id = mappedData.user_id;
              }
              delete mappedData.user_id;
            }

            const urlUpsert = new URL(`${supabaseUrl.replace(/\/$/, "")}/rest/v1/${table}`);
            const response = await fetch(urlUpsert, {
              method: "POST",
              headers: {
                ...supabaseHeaders(supabaseKey),
                "Content-Type": "application/json",
                "Prefer": "resolution=merge-duplicates"
              },
              body: JSON.stringify(mappedData)
            });

            if (!response.ok) {
              const errorText = await response.text();
              console.error("Erro no Supabase ao dar upsert:", errorText);
              return sendJson(res, response.status, { error: "Erro ao salvar perfil no Supabase.", details: errorText });
            }

            console.log("Perfil salvo com sucesso no Supabase!");
            return sendJson(res, 200, { success: true });
          } catch (err) {
            console.error("Erro interno no processamento do perfil:", err);
            return sendJson(res, 500, { error: "Erro interno ao processar perfil." });
          }
        });
        return;
      }
    }

    if (req.method === "GET") {
      const page = routeToPage(pathname);
      if (page) {
        await serveStatic(page, res);
        return;
      }

      if (pathname.startsWith("/styles/") || pathname.startsWith("/scripts/") || pathname.startsWith("/assets/")) {
        await serveStatic(pathname.slice(1), res);
        return;
      }

      if (pathname === "/api/config") {
        res.writeHead(200, {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store, no-cache, must-revalidate",
          Pragma: "no-cache",
          Expires: "0"
        });
        res.end(JSON.stringify({
          url: SUPABASE_URL,
          anonKey: SUPABASE_ANON_KEY
        }));
        return;
      }

      if (pathname === "/api/comuns") {
        const supabaseUrl = process.env.SUPABASE_URL;
        const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
        if (!supabaseUrl || !supabaseKey) {
          return sendJson(res, 500, { error: "Configuração do Supabase ausente." });
        }

        const normalizeValue = (value) => String(value || "").trim();
        const normalizeComum = (item) => {
          // Prioridade para nomes de colunas can\u00F4nicos 'comum' e 'cidade'
          const comum = normalizeValue(item?.comum || item?.name || item?.nome || item?.descricao || item?.description);
          const cidade = normalizeValue(item?.cidade || item?.city || item?.municipio || item?.localidade);
          if (!comum) return null;
          return { comum, cidade };
        };

        const url = new URL(`${supabaseUrl.replace(/\/$/, "")}/rest/v1/comum?select=*`);
        try {
          const response = await fetch(url, {
            headers: {
              ...supabaseHeaders(supabaseKey)
            }
          });
          const data = await response.json();
          const comuns = Array.isArray(data)
            ? data.map(normalizeComum).filter(Boolean).sort((a, b) => a.comum.localeCompare(b.comum, "pt-BR"))
            : [];
          return sendJson(res, 200, comuns);
        } catch (err) {
          return sendJson(res, 500, { error: "Erro ao buscar comuns." });
        }
      }

      sendJson(res, 404, { error: "Rota não encontrada." });
      return;
    }


    sendJson(res, 404, { error: "Rota não encontrada." });
  } catch (error) {
    if (error.message === "payload_too_large") {
      sendJson(res, 413, { error: "Payload excede 1MB." });
      return;
    }

    if (typeof error.message === "string" && error.message.startsWith("supabase_recitativo_duplicate_check_failed:")) {
      sendJson(res, 502, { error: "Falha ao validar duplicidade do lançamento no Supabase." });
      return;
    }

    if (error instanceof SyntaxError) {
      sendJson(res, 400, { error: "JSON inválido." });
      return;
    }

    console.error(error);
    sendJson(res, 500, { error: "Erro interno do servidor." });
  }
}

if (process.env.VERCEL) {
  module.exports = handleRequest;
} else {
  const server = http.createServer((req, res) => {
    handleRequest(req, res);
  });

  server.listen(PORT, () => {
    console.log(`Servidor iniciado em http://localhost:${PORT}`);
  });
}

