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

const sslAgent = new https.Agent({
  rejectUnauthorized: false,
  keepAlive: true,
  secureOptions: crypto.constants.SSL_OP_LEGACY_SERVER_CONNECT,
});

const defaultHeaders = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  Connection: "keep-alive",
  "Upgrade-Insecure-Requests": "1",
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

/* ================= 1. SEARCH ================= */
app.get("/api/search", async (req, res) => {
  const query = req.query.q;
  if (!query) return res.status(400).json({ error: "Query is required" });

  try {
    const formattedQuery = encodeURIComponent(query.trim()).replace(/%20/g, "+");
    const searchUrl = `https://cinesubz.co/?s=${formattedQuery}`;

    const response = await axios.get(searchUrl, {
      httpsAgent: sslAgent,
      timeout: 15000,
      headers: { ...defaultHeaders, Referer: "https://cinesubz.co/" },
    });

    const html = String(response.data || "");
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

    res.json({ success: true, count: results.length, data: results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ================= 2. MOVIE QUALITIES ================= */
app.post("/api/movie", async (req, res) => {
  const { movieUrl } = req.body;
  if (!movieUrl) return res.status(400).json({ error: "Movie URL is required" });

  try {
    const movieHost = new URL(movieUrl).origin;
    const response = await axios.get(movieUrl, {
      httpsAgent: sslAgent,
      timeout: 15000,
      headers: { ...defaultHeaders, Referer: `${movieHost}/` },
    });

    const html = String(response.data || "");
    const titleMatch = html.match(/<title>([\s\S]*?)<\/title>/i);
    const title = titleMatch
      ? decodeHtmlEntities(titleMatch[1].replace(/- CineSubz.*$/i, ""))
      : "Movie Details";

    const downloadLinks = [];
    const seenUrls = new Set();
    const btnRegex =
      /<a[^>]+href=['"]([^'"]+)['"][^>]*class=['"][^'"]*movie-download-button[^'"]*['"][^>]*>([\s\S]*?)<\/a>/gi;
    let match;
    const jobs = [];

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

      jobs.push(
        (async () => {
          try {
            const pageRes = await axios.get(rawLink, {
              httpsAgent: sslAgent,
              headers: { ...defaultHeaders, Referer: movieUrl, Host: new URL(rawLink).host },
              timeout: 10000,
            });
            const pData = String(pageRes.data || "");
            const pathMatch = pData.match(
              /(?:https?:\/\/(?:google\.com|sonic-cloud\.online|drive\.csplayer2\.space))?\/(server\d+\/[^\s'"<>]+\.mp4)/i
            );

            if (pathMatch) {
              const cleanPath = pathMatch[1].replace(/(server\d+\/)\d+:\//, "$1");
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

    const resolved = await Promise.all(jobs);
    for (const item of resolved) {
      if (item && !seenUrls.has(item.directUrl)) {
        seenUrls.add(item.directUrl);
        downloadLinks.push(item);
      }
    }

    res.json({ success: true, title, downloadLinks });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ================= 3. RESOLVE STREAM LINK ================= */
app.post("/api/resolve", async (req, res) => {
  const { streamUrl } = req.body;
  if (!streamUrl) return res.status(400).json({ error: "Stream URL is required" });

  let targetLink = streamUrl.replace(/^https:\/\/[^\/]+/, "https://drive.csplayer2.space");
  targetLink = targetLink.replace(/(server\d+\/)\d+:\//, "$1");

  const serverMatch = targetLink.match(/\/server(\d+)\//);
  const detected = serverMatch ? serverMatch[1] : "2";
  const serversToTry = [detected];
  ["2", "7", "1", "3", "4", "5", "6", "8", "9", "11", "21"].forEach((s) => {
    if (!serversToTry.includes(s)) serversToTry.push(s);
  });

  const logs = [];

  for (const serverNum of serversToTry) {
    const movieUrl = targetLink.replace(/\/server\d+\//, `/server${serverNum}/`);
    logs.push(`Trying Server #${serverNum} (${movieUrl})`);

    try {
      const parsedUrl = new URL(movieUrl);
      const domain = parsedUrl.origin;
      const currentPath = parsedUrl.pathname + parsedUrl.search;

      let sessionCookies = "";

      const initialRes = await axios.get(movieUrl, {
        httpsAgent: sslAgent,
        headers: {
          ...defaultHeaders,
          Host: parsedUrl.host,
          Referer: `${domain}/`,
        },
        timeout: 10000,
      });

      if (initialRes.headers["set-cookie"]) {
        sessionCookies = initialRes.headers["set-cookie"].map((c) => c.split(";")[0]).join("; ");
      }

      let html = String(initialRes.data || "");
      let realPostUrl = movieUrl;
      const hexRegex = /[0-9a-fA-F]{200,}/g;
      let payloads = html.match(hexRegex) || [];

      if (payloads.length === 0) {
        const apiUrl = `${domain}/api/download-data${currentPath}`;
        try {
          const apiRes = await axios.get(apiUrl, {
            httpsAgent: sslAgent,
            timeout: 10000,
            headers: {
              ...defaultHeaders,
              Accept: "application/json, text/plain, */*",
              Referer: movieUrl,
              Cookie: sessionCookies,
              Host: parsedUrl.host,
            },
          });

          if (apiRes.headers["set-cookie"]) {
            const apiCookies = apiRes.headers["set-cookie"].map((c) => c.split(";")[0]).join("; ");
            sessionCookies = sessionCookies ? `${sessionCookies}; ${apiCookies}` : apiCookies;
          }

          if (apiRes.data && apiRes.data.redirect) {
            realPostUrl = apiRes.data.redirect;
            if (!realPostUrl.startsWith("http")) realPostUrl = domain + realPostUrl;

            const redRes = await axios.get(realPostUrl, {
              httpsAgent: sslAgent,
              timeout: 10000,
              headers: {
                ...defaultHeaders,
                Referer: movieUrl,
                Cookie: sessionCookies,
                Host: parsedUrl.host,
              },
            });

            html = String(redRes.data || "");
            payloads = html.match(hexRegex) || [];
          }
        } catch (apiErr) {
          logs.push(`Server #${serverNum} API error: ${apiErr.response?.status || apiErr.message}`);
          continue;
        }
      }

      if (payloads.length === 0) continue;

      const domStrings = [...html.matchAll(/(["'])(.*?)\1/g)].map((m) => m[2]);
      const keys = [...new Set(domStrings)].filter((k) => k && k.length >= 4 && k.length <= 40);
      keys.push("kasun", "cinesubz.lk", "CSPlayer", "ravindu01manoj", "jhutmupd", "dgpjjitp");

      const discoveredLinks = [];

      for (let i = 0; i < payloads.length; i++) {
        const hex = payloads[i];
        try {
          const payloadBytes = Buffer.from(hex, "hex");
          const postRes = await axios.post(realPostUrl, payloadBytes, {
            httpsAgent: sslAgent,
            timeout: 10000,
            headers: {
              "User-Agent": defaultHeaders["User-Agent"],
              Accept: "*/*",
              Connection: "keep-alive",
              "Content-Type": "application/octet-stream",
              Cookie: sessionCookies,
              Origin: domain,
              Referer: realPostUrl,
              Host: parsedUrl.host,
            },
            responseType: "arraybuffer",
          });

          const resText = Buffer.from(postRes.data).toString("utf8");
          const encMatch = resText.match(/U2FsdGVkX1[a-zA-Z0-9+/=]+/);

          if (encMatch) {
            const encryptedStr = encMatch[0];
            for (const k of keys) {
              try {
                const dec = CryptoJS.AES.decrypt(encryptedStr, k).toString(CryptoJS.enc.Utf8);
                let finalStr = dec;

                if (finalStr && !finalStr.startsWith("http")) {
                  try {
                    finalStr = Buffer.from(finalStr, "base64").toString("utf8");
                  } catch (_) {}
                }

                if (finalStr && finalStr.startsWith("http")) {
                  discoveredLinks.push({ key: k, url: finalStr });
                  break;
                }
              } catch (_) {}
            }
          }
        } catch (_) {}
      }

      if (discoveredLinks.length > 0) {
        return res.json({
          success: true,
          server: `server${serverNum}`,
          links: discoveredLinks,
          logs,
        });
      }
    } catch (err) {
      logs.push(`Server #${serverNum} failed: ${err.response?.status || err.message}`);
    }
  }

  res.status(500).json({ error: "Failed to decrypt from all servers", logs });
});

app.listen(port, () => {
  console.log(`🚀 CineSubz Resolver running at http://localhost:${port}`);
});
