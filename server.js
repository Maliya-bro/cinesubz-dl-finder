import express from "express";
import axios from "axios";
import CryptoJS from "crypto-js";
import https from "https";
import crypto from "crypto";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

/* ================= CLOUDFLARE WAF BYPASS TLS AGENT ================= */
// Node.js බව සඟවා Real Browser එකක TLS Fingerprint එකක් යැවීම
const sslAgent = new https.Agent({
  rejectUnauthorized: false,
  keepAlive: true,
  ciphers: [
    "TLS_AES_128_GCM_SHA256",
    "TLS_AES_256_GCM_SHA384",
    "TLS_CHACHA20_POLY1305_SHA256",
    "ECDHE-ECDSA-AES128-GCM-SHA256",
    "ECDHE-RSA-AES128-GCM-SHA256",
    "ECDHE-ECDSA-AES256-GCM-SHA384",
    "ECDHE-RSA-AES256-GCM-SHA384",
    "ECDHE-ECDSA-CHACHA20-POLY1305",
    "ECDHE-RSA-CHACHA20-POLY1305",
    "ECDHE-RSA-AES128-SHA",
    "ECDHE-RSA-AES256-SHA",
    "AES128-GCM-SHA256",
    "AES256-GCM-SHA384",
    "AES128-SHA",
    "AES256-SHA",
  ].join(":"),
  honorCipherOrder: true,
  minVersion: "TLSv1.2",
  maxVersion: "TLSv1.3",
  secureOptions:
    crypto.constants.SSL_OP_LEGACY_SERVER_CONNECT |
    crypto.constants.SSL_OP_NO_TICKET,
});

/* ================= REAL BROWSER HEADERS ================= */
const defaultHeaders = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "sec-ch-ua": '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"Windows"',
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "cross-site",
  "Sec-Fetch-User": "?1",
  "Upgrade-Insecure-Requests": "1",
  "Connection": "keep-alive",
};

function decodeHtmlEntities(str = "") {
  return String(str)
    .replace(/&#8211;|&#8212;|&ndash;|&mdash;/g, "-")
    .replace(/&#8217;|&#8216;|&apos;/g, "'")
    .replace(/&#8220;|&#8221;|&quot;/g, '"')
    .replace(/&#038;|&amp;/g, "&")
    .replace(/<[^>]*>/g, "")
    .trim();
}

/* ================= 1. NATIVE SEARCH ================= */
async function nativeSearchCineSubz(query) {
  const formattedQuery = encodeURIComponent(query.trim()).replace(/%20/g, "+");
  const searchUrl = `https://cinesubz.co/?s=${formattedQuery}`;

  const res = await axios.get(searchUrl, {
    httpsAgent: sslAgent,
    timeout: 15000,
    headers: { ...defaultHeaders, Referer: "https://cinesubz.co/" },
  });

  const html = String(res.data || "");
  const results = [];
  const seenUrls = new Set();
  const parts = html.split(/<div id="item-\d+"\s+class="display-item">/i).slice(1);

  for (const block of parts) {
    const linkMatch = block.match(/<a\s+href="([^"]+)"[^>]*?(?:title="([^"]*)")?/i);
    const h3Match =
      block.match(/<div class="item-desc-title">\s*<h3>([\s\S]*?)<\/h3>/i) ||
      block.match(/<h3>([\s\S]*?)<\/h3>/i);
    const imgMatch = block.match(/<img[^>]+(?:data-original|src)="([^"]+)"/i);
    const imdbMatch = block.match(/<span class="imdb-score">([^<]+)<\/span>/i);
    const qualityMatch = block.match(/<span class="badge-(?:quality|season)-corner">([^<]+)<\/span>/i);

    const url = linkMatch ? linkMatch[1].trim() : null;
    const rawTitle = (h3Match && h3Match[1]) || (linkMatch && linkMatch[2]) || "";
    const title = decodeHtmlEntities(rawTitle);
    const image = imgMatch ? imgMatch[1].trim() : "";
    const imdb = imdbMatch ? imdbMatch[1].trim() : "N/A";
    const quality = qualityMatch ? qualityMatch[1].trim() : "N/A";

    if (url && title && !seenUrls.has(url)) {
      seenUrls.add(url);
      results.push({ title, url, image, imdb, quality });
    }
  }

  return results;
}

/* ================= 2. NATIVE MOVIE PAGE SCRAPER ================= */
async function nativeScrapeMovie(movieUrl) {
  const parsed = new URL(movieUrl);
  const movieHost = parsed.origin;

  const res = await axios.get(movieUrl, {
    httpsAgent: sslAgent,
    timeout: 15000,
    headers: { ...defaultHeaders, Referer: `${movieHost}/` },
  });

  const html = String(res.data || "");
  const titleMatch = html.match(/<title>([\s\S]*?)<\/title>/i);
  const title = titleMatch
    ? decodeHtmlEntities(titleMatch[1].replace(/- CineSubz.*$/i, ""))
    : "Movie Details";

  const downloadLinks = [];
  const seenUrls = new Set();
  const btnRegex =
    /<a[^>]+href=['"]([^'"]+)['"][^>]*class=['"][^'"]*movie-download-button[^'"]*['"][^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  const buttonJobs = [];

  while ((match = btnRegex.exec(html)) !== null) {
    const rawLink = match[1].trim();
    const innerHtml = match[2];
    const metaMatch = innerHtml.match(/class=['"][^'"]*movie-download-meta[^'"]*['"][^>]*>([\s\S]*?)<\/span>/i);
    const typeMatch = innerHtml.match(/class=['"][^'"]*movie-download-type[^'"]*['"][^>]*>([\s\S]*?)<\/span>/i);

    const qualityLabel = metaMatch
      ? decodeHtmlEntities(metaMatch[1])
      : typeMatch
      ? decodeHtmlEntities(typeMatch[1])
      : "Quality";

    buttonJobs.push(
      (async () => {
        try {
          const pageRes = await axios.get(rawLink, {
            httpsAgent: sslAgent,
            headers: {
              ...defaultHeaders,
              Referer: movieUrl,
              Host: new URL(rawLink).host,
            },
            timeout: 12000,
          });
          const pData = String(pageRes.data || "");
          const pathMatch = pData.match(
            /(?:https?:\/\/(?:google\.com|sonic-cloud\.online|drive\.csplayer2\.space))?\/(server\d+\/[^\s'"<>]+\.mp4)/i
          );

          if (pathMatch) {
            let cleanPath = pathMatch[1].replace(/(server\d+\/)\d+:\//, "$1");
            return {
              quality: qualityLabel,
              directUrl: `https://drive.csplayer2.space/${cleanPath}`,
            };
          }
        } catch (_) {}
        return null;
      })()
    );
  }

  const resolved = await Promise.all(buttonJobs);
  for (const item of resolved) {
    if (item && !seenUrls.has(item.directUrl)) {
      seenUrls.add(item.directUrl);
      downloadLinks.push(item);
    }
  }

  return { title, downloadLinks };
}

/* ================= 3. DIRECT DOWNLOAD RESOLVER ================= */
async function resolveDirectLinks(streamUrl) {
  let targetLink = streamUrl.replace(/^https:\/\/[^\/]+/, "https://drive.csplayer2.space");
  targetLink = targetLink.replace(/(server\d+\/)\d+:\//, "$1");

  const serverMatch = targetLink.match(/\/server(\d+)\//) || targetLink.match(/server(\d+)/);
  const detectedServer = serverMatch ? serverMatch[1] : "7";

  const serversToTry = [detectedServer];
  ["7", "2", "1", "3", "4", "5", "6", "8", "9", "11", "21"].forEach((s) => {
    if (!serversToTry.includes(s)) serversToTry.push(s);
  });

  const debugLogs = [];

  for (const serverNum of serversToTry) {
    let movieUrl = targetLink;
    if (serverMatch) {
      movieUrl = movieUrl.replace(/server\d+/, `server${serverNum}`);
    }

    debugLogs.push(`Testing Server #${serverNum} (${movieUrl})`);

    try {
      const parsedUrl = new URL(movieUrl);
      const domain = parsedUrl.origin;
      const currentPath = parsedUrl.pathname + parsedUrl.search;

      const baseHeaders = {
        ...defaultHeaders,
        Host: parsedUrl.host,
        Referer: "https://cinesubz.co/", // Important to bypass 403
      };

      const initialRes = await axios.get(movieUrl, {
        httpsAgent: sslAgent,
        headers: baseHeaders,
        timeout: 12000,
      });

      let cookieHeader = "";
      if (initialRes.headers["set-cookie"]) {
        cookieHeader = initialRes.headers["set-cookie"]
          .map((c) => c.split(";")[0])
          .join("; ");
      }

      let html = String(initialRes.data || "");
      let realPageUrl = movieUrl;
      const hexRegex = /[0-9a-fA-F]{200,}/g;
      let payloads = html.match(hexRegex) || [];

      if (payloads.length === 0) {
        const apiUrl = `${domain}/api/download-data${currentPath}`;
        try {
          const apiResponse = await axios.get(apiUrl, {
            httpsAgent: sslAgent,
            timeout: 12000,
            headers: {
              ...baseHeaders,
              Accept: "application/json, text/plain, */*",
              Referer: movieUrl,
              Cookie: cookieHeader,
              "Sec-Fetch-Site": "same-origin",
            },
          });

          if (apiResponse.headers["set-cookie"]) {
            const apiCookies = apiResponse.headers["set-cookie"]
              .map((c) => c.split(";")[0])
              .join("; ");
            cookieHeader = cookieHeader ? `${cookieHeader}; ${apiCookies}` : apiCookies;
          }

          if (apiResponse.data && apiResponse.data.redirect) {
            realPageUrl = apiResponse.data.redirect;
            if (!realPageUrl.startsWith("http")) realPageUrl = domain + realPageUrl;

            const pageResponse = await axios.get(realPageUrl, {
              httpsAgent: sslAgent,
              timeout: 12000,
              headers: {
                ...baseHeaders,
                Referer: movieUrl,
                Cookie: cookieHeader,
              },
            });
            html = String(pageResponse.data || "");
            payloads = html.match(hexRegex) || [];
          }
        } catch (apiErr) {
          debugLogs.push(`Server #${serverNum} API error: ${apiErr.response?.status || apiErr.message}`);
          continue;
        }
      }

      if (payloads.length === 0) continue;

      const allStrings = [...html.matchAll(/(["'])(.*?)\1/g)].map((m) => m[2]);
      const keysToTry = [...new Set(allStrings)].filter((k) => k && k.length >= 4 && k.length <= 40);
      keysToTry.push("kasun", "cinesubz.lk", "CSPlayer", "ravindu01manoj", "jhutmupd", "dgpjjitp");

      const resolved = [];

      for (const hexPayload of payloads) {
        try {
          const payloadBytes = Buffer.from(hexPayload, "hex");
          const postHeaders = {
            "User-Agent": defaultHeaders["User-Agent"],
            Accept: "*/*",
            "Accept-Language": "en-US,en;q=0.9",
            Connection: "keep-alive",
            "Content-Type": "application/octet-stream",
            Cookie: cookieHeader,
            Origin: domain,
            Referer: realPageUrl,
            Host: parsedUrl.host,
            "Sec-Fetch-Dest": "empty",
            "Sec-Fetch-Mode": "cors",
            "Sec-Fetch-Site": "same-origin",
          };

          const dlResponse = await axios.post(realPageUrl, payloadBytes, {
            httpsAgent: sslAgent,
            headers: postHeaders,
            responseType: "arraybuffer",
            timeout: 12000,
          });

          const responseText = Buffer.from(dlResponse.data).toString("utf8");
          const encryptedUrlMatch = responseText.match(/U2FsdGVkX1[a-zA-Z0-9+/=]+/);

          if (encryptedUrlMatch) {
            const encryptedUrl = encryptedUrlMatch[0];
            for (const key of keysToTry) {
              if (!key || key.length < 3) continue;
              try {
                const decryptedBytes = CryptoJS.AES.decrypt(encryptedUrl, key);
                let decodedStr = decryptedBytes.toString(CryptoJS.enc.Utf8);

                if (decodedStr && !decodedStr.startsWith("http")) {
                  try {
                    decodedStr = Buffer.from(decodedStr, "base64").toString("utf8");
                  } catch (_) {}
                }

                if (decodedStr && decodedStr.startsWith("http")) {
                  resolved.push({ key, url: decodedStr });
                  break;
                }
              } catch (_) {}
            }
          }
        } catch (_) {} // Skip payload 404s
      }

      if (resolved.length > 0) {
        return {
          success: true,
          server: `server${serverNum}`,
          links: resolved,
          logs: debugLogs,
        };
      }
    } catch (err) {
      debugLogs.push(`Server #${serverNum} failed: ${err.response?.status || err.message}`);
    }
  }

  return {
    success: false,
    error: "Failed to decrypt from all servers.",
    logs: debugLogs,
  };
}

/* ================= EXPRESS ENDPOINTS ================= */
app.get("/api/search", async (req, res) => {
  const query = req.query.q;
  if (!query) return res.status(400).json({ error: "Query 'q' is required" });

  try {
    const data = await nativeSearchCineSubz(query);
    res.json({ success: true, count: data.length, data: data.slice(0, 15) });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.post("/api/movie", async (req, res) => {
  const { movieUrl } = req.body;
  if (!movieUrl) return res.status(400).json({ error: "movieUrl is required" });

  try {
    const data = await nativeScrapeMovie(movieUrl);
    if (!data.downloadLinks || data.downloadLinks.length === 0) {
      return res.status(404).json({ success: false, error: "No download links discovered" });
    }
    res.json({ success: true, ...data });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.post("/api/resolve", async (req, res) => {
  const { directUrl } = req.body;
  if (!directUrl) return res.status(400).json({ error: "directUrl is required" });

  try {
    const result = await resolveDirectLinks(directUrl);
    if (result.success) {
      res.json(result);
    } else {
      res.status(500).json(result);
    }
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.listen(port, () => {
  console.log(`🚀 CineSubz Railway Resolver active on port ${port}`);
});
