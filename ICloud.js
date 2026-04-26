export default {
  async fetch(request) {
    const url = new URL(request.url);

    try {
      const shareId = getShareId(url);
      const { downloadURL, fileName, cacheStatus } =
        await resolveFileInfoCached(request, shareId);

      const country =
        request.headers.get("cf-ipcountry") ||
        request.cf?.country ||
        "";

      let finalURL = injectFilename(downloadURL, fileName);
      const patched = shouldPatchChinaDomain(finalURL, country);
      if (patched) {
        finalURL = patchChinaDomain(finalURL);
      }

      const finalHost = new URL(finalURL).hostname;

      return new Response(null, {
        status: 302,
        headers: {
          location: finalURL,
          "x-debug-country": country || "unknown",
          "x-debug-domain-patched": patched ? "yes" : "no",
          "x-debug-final-host": finalHost,
          "x-debug-cache": cacheStatus,
          "cache-control": "no-store",
        },
      });
    } catch (err) {
      return new Response(
        "error=" + (err && err.message ? err.message : String(err)),
        {
          status: 400,
          headers: {
            "content-type": "text/plain; charset=utf-8",
            "cache-control": "no-store",
            "x-debug-country":
              request.headers.get("cf-ipcountry") ||
              request.cf?.country ||
              "unknown",
          },
        }
      );
    }
  },
};

function getShareId(url) {
  const path = url.pathname.replace(/^\/+/, "").trim();
  const queryUrl = url.searchParams.get("url");

  if (queryUrl) {
    return extractShareId(queryUrl);
  }

  if (!path) {
    throw new Error("Use /<shareId> or ?url=<icloud_share_url>");
  }

  if (/^https?:\/\//i.test(path)) {
    return extractShareId(path);
  }

  return decodeURIComponentSafe(path);
}

function extractShareId(shareUrl) {
  const url = new URL(shareUrl);
  const parts = url.pathname.split("/").filter(Boolean);
  const idx = parts.findIndex((part) => part === "iclouddrive");

  if (idx === -1 || !parts[idx + 1]) {
    throw new Error("Invalid iCloud Drive share URL");
  }

  return parts[idx + 1];
}

function decodeURIComponentSafe(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

async function resolveFileInfoCached(request, shareId) {
  const cache = caches.default;

  // 用当前域名构造 cache key，避免假 host
  const cacheUrl = new URL(request.url);
  cacheUrl.pathname = `/__icloud_resolve_cache__/${encodeURIComponent(shareId)}`;
  cacheUrl.search = "";

  const cacheKey = new Request(cacheUrl.toString(), {
    method: "GET",
  });

  const cached = await cache.match(cacheKey);
  if (cached) {
    const data = await cached.json();
    return {
      ...data,
      cacheStatus: "hit",
    };
  }

  const data = await resolveFileInfo(shareId);

  const cacheTTL = 600; // 10 分钟
  const cacheResp = new Response(JSON.stringify(data), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": `public, max-age=${cacheTTL}`,
    },
  });

  await cache.put(cacheKey, cacheResp);

  return {
    ...data,
    cacheStatus: "miss",
  };
}

async function resolveFileInfo(shareId) {
  const resp = await fetch(
    "https://ckdatabasews.icloud.com/database/1/com.apple.cloudkit/production/public/records/resolve",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        shortGUIDs: [{ value: shareId }],
      }),
    }
  );

  if (!resp.ok) {
    throw new Error(`iCloud resolve HTTP ${resp.status}`);
  }

  const json = await resp.json();
  const result = json?.results?.[0];
  const fields = result?.rootRecord?.fields || {};

  const downloadURL = fields?.fileContent?.value?.downloadURL;
  const encryptedBasename = fields?.encryptedBasename?.value || "";
  const extension = fields?.extension?.value || "";
  const title = result?.share?.fields?.["cloudkit.title"]?.value || "";

  if (!downloadURL) {
    throw new Error("No downloadURL found in iCloud response");
  }

  const baseName = decodeBase64Utf8(encryptedBasename) || title || "download";
  const fileName = extension ? `${baseName}.${extension}` : baseName;

  return { downloadURL, fileName };
}

function decodeBase64Utf8(value) {
  if (!value) return "";

  try {
    const binary = atob(value);
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    return new TextDecoder("utf-8").decode(bytes);
  } catch {
    return "";
  }
}

function injectFilename(downloadURL, fileName) {
  const encodedName = encodeURIComponent(fileName);

  return downloadURL
    .replace("${f}", encodedName)
    .replace("%24%7Bf%7D", encodedName)
    .replace("$%7Bf%7D", encodedName);
}

function shouldPatchChinaDomain(downloadURL, country) {
  if (country !== "CN") return false;

  try {
    const url = new URL(downloadURL);
    return url.hostname === "cvws.icloud-content.com";
  } catch {
    return false;
  }
}

function patchChinaDomain(downloadURL) {
  const url = new URL(downloadURL);

  if (url.hostname === "cvws.icloud-content.com") {
    url.hostname = "cvws.icloud-content.com.cn";
  }

  return url.toString();
}