export default {
  async fetch(request) {
    const url = new URL(request.url);

    try {
      const shareURL = getShareURL(url);
      const { directURL, cacheStatus } = await resolveDirectLinkCached(
        request,
        shareURL
      );
      const finalHost = new URL(directURL).hostname;

      return new Response(null, {
        status: 302,
        headers: {
          location: directURL,
          "x-debug-final-host": finalHost,
          "x-debug-cache": cacheStatus,
          "cache-control": "no-store",
        },
      });
    } catch (err) {
      return new Response(
        "error=" + formatError(err),
        {
          status: 400,
          headers: {
            "content-type": "text/plain; charset=utf-8",
            "cache-control": "no-store",
          },
        }
      );
    }
  },
};

function getShareURL(url) {
  const queryURL = url.searchParams.get("url");
  if (queryURL) {
    return decodeURIComponentSafe(queryURL.trim());
  }

  let path = url.pathname.replace(/^\/+/, "").trim();
  path = stripOptionalPrefix(path);

  if (!path) {
    throw new Error("Use /<share_url> or ?url=<onedrive_share_url>");
  }

  return rebuildEmbeddedURL(decodeURIComponentSafe(path), url.search);
}

function stripOptionalPrefix(path) {
  for (const prefix of ["onedrive/", "oddl/"]) {
    if (path.startsWith(prefix)) {
      return path.slice(prefix.length);
    }
  }
  return path;
}

function decodeURIComponentSafe(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function rebuildEmbeddedURL(pathValue, outerSearch) {
  if (!/^https?:\/\//i.test(pathValue)) {
    return pathValue;
  }

  if (!outerSearch || pathValue.includes("?")) {
    return pathValue;
  }

  return pathValue + outerSearch;
}

async function resolveDirectLinkCached(request, shareURL) {
  const cache = caches.default;

  // Use the current worker host to build a stable cache key.
  const cacheUrl = new URL(request.url);
  cacheUrl.pathname = `/__onedrive_resolve_cache__/${encodeURIComponent(shareURL)}`;
  cacheUrl.search = "";

  const cacheKey = new Request(cacheUrl.toString(), {
    method: "GET",
  });

  const cached = await cache.match(cacheKey);
  if (cached) {
    const data = await cached.json();
    return {
      directURL: data.directURL,
      cacheStatus: "hit",
    };
  }

  const directURL = await resolveDirectLink(shareURL);
  const cacheTTL = 600; // 10 minutes

  await cache.put(
    cacheKey,
    new Response(JSON.stringify({ directURL }), {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": `public, max-age=${cacheTTL}`,
      },
    })
  );

  return {
    directURL,
    cacheStatus: "miss",
  };
}

function formatError(err) {
  if (err instanceof Error && err.message) {
    return err.message;
  }

  if (typeof err === "string") {
    return err;
  }

  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

function assertSupportedShareURL(shareURL) {
  let parsed;

  try {
    parsed = new URL(shareURL);
  } catch {
    throw new Error("Invalid URL: expected a full OneDrive/SharePoint share URL");
  }

  const host = (parsed.hostname || "").toLowerCase();
  const supported = [
    "1drv.ms",
    "onedrive.live.com",
    "sharepoint.com",
    "my.sharepoint.com",
    "sharepoint.cn",
    "my.sharepoint.cn",
  ];

  if (!supported.some((suffix) => host.endsWith(suffix))) {
    throw new Error("Unsupported host: only OneDrive/SharePoint share links are accepted");
  }

  return parsed;
}

async function resolveDirectLink(shareURL) {
  const parsed = assertSupportedShareURL(shareURL);
  const host = parsed.hostname.toLowerCase();

  if (isSharePointHost(host)) {
    return convertSharePointToDirectLink(parsed);
  }

  if (host.endsWith("1drv.ms")) {
    return await resolveRedirectTarget(
      `https://dlink.host/1drv/${encodeDlinkPayload(shareURL)}`
    );
  }

  const expandedURL = await normalizeURL(shareURL);
  return await convertPersonalOneDriveToDirectLink(shareURL, expandedURL);
}

function isSharePointHost(host) {
  return (
    host.includes("sharepoint.com") ||
    host.includes("sharepoint.cn") ||
    host.includes("my.sharepoint")
  );
}

async function normalizeURL(originalURL) {
  let resp;

  try {
    resp = await fetch(originalURL, {
      method: "HEAD",
      redirect: "follow",
    });
  } catch {
    resp = await fetch(originalURL, {
      method: "GET",
      redirect: "follow",
    });
  }

  if (resp.status === 405 || resp.status === 403 || resp.redirected) {
    resp = await fetch(originalURL, {
      method: "GET",
      redirect: "follow",
    });
  }

  return resp.url;
}

function convertSharePointToDirectLink(parsedURL) {
  const match = parsedURL.pathname.match(/\/:u:\/g\/personal\/([^/]+)\/([^/?#]+)/);

  if (!match) {
    throw new Error("Unsupported SharePoint URL format");
  }

  const personalUser = match[1];
  const shareToken = match[2];
  return `https://${parsedURL.host}/personal/${personalUser}/_layouts/52/download.aspx?share=${shareToken}`;
}

async function convertPersonalOneDriveToDirectLink(originalURL, expandedURL) {
  const dlinkURL = buildDlinkHostURL(originalURL, expandedURL);
  if (dlinkURL) {
    try {
      return await resolveRedirectTarget(dlinkURL);
    } catch {
      // Fall through to Microsoft-native fallback URLs.
    }
  }

  const expanded = new URL(expandedURL);
  const resid = expanded.searchParams.get("resid");
  const authkey = expanded.searchParams.get("authkey");

  if (resid && authkey) {
    return `https://onedrive.live.com/download?resid=${encodeURIComponent(
      resid
    )}&authkey=${encodeURIComponent(authkey)}`;
  }

  return ensureDownloadParamFallback(expanded);
}

function buildDlinkHostURL(originalURL, expandedURL) {
  const expanded = new URL(expandedURL);
  const redeem = expanded.searchParams.get("redeem");
  if (redeem) {
    return `https://dlink.host/1drv/${redeem}`;
  }

  const originalHost = new URL(originalURL).hostname.toLowerCase();
  if (originalHost.endsWith("1drv.ms")) {
    return `https://dlink.host/1drv/${encodeDlinkPayload(originalURL)}`;
  }

  return null;
}

function encodeDlinkPayload(value) {
  const bytes = new TextEncoder().encode(value);
  let binary = "";

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function resolveRedirectTarget(url) {
  try {
    const manualResp = await fetch(url, {
      method: "GET",
      redirect: "manual",
    });

    const location = manualResp.headers.get("location");
    if (location) {
      return new URL(location, url).toString();
    }
  } catch {
    // Fall through to follow-mode fetch below.
  }

  try {
    const headResp = await fetch(url, {
      method: "HEAD",
      redirect: "follow",
    });

    if (headResp.url && headResp.url !== url) {
      return headResp.url;
    }
  } catch {
    // Fall through to GET follow below.
  }

  const getResp = await fetch(url, {
    method: "GET",
    redirect: "follow",
  });

  if (getResp.url && getResp.url !== url) {
    return getResp.url;
  }

  throw new Error("Redirect resolver did not return a direct download URL");
}

function ensureDownloadParamFallback(parsedURL) {
  const url = new URL(parsedURL.toString());
  if (!url.searchParams.has("download")) {
    url.searchParams.set("download", "1");
  }
  return url.toString();
}
