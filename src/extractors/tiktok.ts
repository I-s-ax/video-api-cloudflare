// Adaptador de extracción para TikTok (API pública móvil Aweme, sin marca de agua).
// Resuelve enlaces cortos (vm.tiktok.com), obtiene el ID del video y consulta
// la API Aweme para el enlace de descarga directa del MP4.

const USER_AGENT =
  "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36";

// Android bloquea el tráfico en texto plano (cleartext): si TikTok devuelve
// una URL http://, el DownloadManager la cancela. Forzar siempre https.
const forceHttps = (u: string): string =>
  u.startsWith("http://") ? "https://" + u.slice("http://".length) : u;

// Seguir la cadena de redirecciones (301/302) de la URL de descarga y
// devolver la URL final de la CDN, SIN descargar el cuerpo del video.
// El DownloadManager de Android elimina las cabeceras personalizadas
// (User-Agent, Referer) al seguir una redirección entre dominios y la CDN
// responde 403; con la URL final no hay redirección y las cabeceras se
// mantienen. Si algo falla, se devuelve la URL original como respaldo.
async function resolveFinalUrl(startUrl: string): Promise<string> {
  let current = startUrl;
  for (let i = 0; i < 5; i++) {
    let res: Response;
    try {
      res = await fetch(current, {
        method: "GET",
        redirect: "manual",
        headers: { "user-agent": USER_AGENT, referer: "https://www.tiktok.com/" },
      });
    } catch {
      return current;
    }
    if (res.body) {
      try {
        await res.body.cancel();
      } catch {
        // Ignorar: solo nos interesa la cabecera Location, no el cuerpo.
      }
    }
    const location = res.headers.get("location");
    if ([301, 302, 303, 307, 308].includes(res.status) && location) {
      current = forceHttps(new URL(location, current).toString());
      continue;
    }
    return current;
  }
  return current;
}

export type TikTokExtract = {
  platform: "tiktok";
  video_id: string;
  title: string;
  author: string;
  duration_ms: number;
  width: number;
  height: number;
  download_url: string;
  downloadUrl: string;
  watermark: boolean;
  formats: { download_url: string; format: string; quality: string; watermark: boolean }[];
};

export async function extractTikTok(url: string): Promise<TikTokExtract> {
  // 1. Seguir la redirección del enlace corto (vm.tiktok.com) si es necesario.
  const response = await fetch(url, {
    redirect: "follow",
    headers: { "user-agent": USER_AGENT, accept: "text/html,application/xhtml+xml" },
  });
  const finalUrl = response.url || url;

  // 2. Extraer el ID del video de la URL final (o de la original como respaldo).
  const videoIdMatch = finalUrl.match(/video\/(\d+)/) || url.match(/video\/(\d+)/);
  if (!videoIdMatch) {
    throw new Error("VIDEO_ID_NOT_FOUND");
  }
  const videoId = videoIdMatch[1];

  // 3. Consultar la API pública móvil de TikTok (Aweme). Si responde con
  // límite de peticiones (429) o error, esperar un poco y reintentar con
  // otro host.
  const awemeHosts = [
    "api16-normal-c-useast1a.tiktokv.com",
    "api19-normal-c-useast1a.tiktokv.com",
    "api22-normal-c-useast1a.tiktokv.com",
  ];
  let video: any = null;
  let aweme: any = null;
  let lastError = "";
  let source: "aweme" | "page" = "aweme";
  for (const host of awemeHosts) {
    try {
      const apiRes = await fetch(`https://${host}/aweme/v1/feed/?aweme_id=${videoId}`, {
        headers: { "user-agent": USER_AGENT },
      });
      if (!apiRes.ok) {
        lastError = `TIKTOK_API_ERROR_${apiRes.status}`;
        await new Promise((r) => setTimeout(r, 1500));
        continue;
      }
      const data: any = await apiRes.json();
      aweme = data?.aweme_list?.[0];
      video = aweme?.video;
      if (video) break;
      lastError = "VIDEO_NOT_FOUND";
    } catch (e) {
      lastError = e instanceof Error ? e.message : "TIKTOK_API_ERROR";
    }
  }

  // 4. Respaldo: si Aweme no respondió, leer el HTML de la página del video
  // y buscar el JSON embebido (__UNIVERSAL_DATA_FOR_REHYDRATION__).
  if (!video) {
    try {
      const pageRes = await fetch(finalUrl, {
        headers: { "user-agent": USER_AGENT, accept: "text/html,application/xhtml+xml" },
      });
      const html = await pageRes.text();
      const jsonMatch = html.match(
        /<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application\/json">(.*?)<\/script>/s,
      );
      if (jsonMatch) {
        const pageData: any = JSON.parse(jsonMatch[1]);
        // Buscar recursivamente el itemStruct del video (la ruta cambia
        // según la versión de TikTok: webapp.video-detail o webapp.reflow...).
        const findItem = (node: any): any => {
          if (!node || typeof node !== "object") return null;
          const video = node?.video;
          if (video && (video.downloadAddr || video.playAddr)) return node;
          for (const value of Object.values(node)) {
            const found = findItem(value);
            if (found) return found;
          }
          return null;
        };
        const itemStruct = findItem(pageData);
        if (itemStruct?.video) {
          aweme = itemStruct;
          source = "page";
          // Normalizar a la forma de Aweme (url_list) para el paso siguiente.
          video = {
            ...itemStruct.video,
            download_addr: itemStruct.video.downloadAddr
              ? { url_list: [itemStruct.video.downloadAddr] }
              : undefined,
            play_addr: itemStruct.video.playAddr
              ? { url_list: [itemStruct.video.playAddr] }
              : undefined,
          };
        }
      }
    } catch {
      // Se ignora: el error final se reporta abajo.
    }
  }
  if (!video) {
    throw new Error(lastError || "VIDEO_NOT_FOUND");
  }

  // 5. Elegir la URL de descarga.
  // Cuando Aweme responde, la URL principal es play_addr: es el enlace
  // directo de la CDN de TikTok (v16m) y es el que el reproductor web usa.
  // download_addr (sin marca de agua) va como segundo formato: su punto
  // de descarga (api.tiktokv.com) y las URLs de la página (v16-webapp)
  // han devuelto 403 al descargar desde el teléfono.
  // Cuando solo hay respaldo de página, se usa lo que haya (downloadAddr
  // primero, playAddr después).
  const noWatermark = video?.download_addr?.url_list?.[0] as string | undefined;
  const withWatermark = video?.play_addr?.url_list?.[0] as string | undefined;
  const primary = source === "aweme" ? withWatermark || noWatermark : noWatermark || withWatermark;
  const secondary = source === "aweme" ? noWatermark : withWatermark;
  const downloadUrl = forceHttps(primary || "");
  if (!downloadUrl) {
    throw new Error("DOWNLOAD_URL_NOT_FOUND");
  }
  const formats: { download_url: string; format: string; quality: string; watermark: boolean }[] = [
    {
      download_url: downloadUrl,
      format: "mp4",
      quality: `${(video?.height as number) || 0}p`,
      watermark: primary === withWatermark,
    },
  ];
  if (secondary && forceHttps(secondary) !== downloadUrl) {
    formats.push({
      download_url: forceHttps(secondary),
      format: "mp4",
      quality: `${(video?.height as number) || 0}p`,
      watermark: secondary === withWatermark,
    });
  }

  // 6. Resolver la redirección hacia la CDN final para que el
  // DownloadManager no tenga que seguirla (y no pierda las cabeceras).
  let finalDownloadUrl = downloadUrl;
  try {
    finalDownloadUrl = await resolveFinalUrl(downloadUrl);
  } catch {
    finalDownloadUrl = downloadUrl;
  }
  console.log("extract_tiktok", JSON.stringify({
    video_id: videoId,
    source,
    source_host: new URL(downloadUrl).hostname,
    final_host: new URL(finalDownloadUrl).hostname,
    redirected: finalDownloadUrl !== downloadUrl,
    watermark: primary === withWatermark,
  }));

  const title = (aweme?.desc as string) || "TikTok Video";
  return {
    platform: "tiktok",
    video_id: videoId,
    title,
    author: (aweme?.author?.unique_id as string) || "",
    duration_ms: (video?.duration as number) || 0,
    width: (video?.width as number) || 0,
    height: (video?.height as number) || 0,
    download_url: finalDownloadUrl,
    downloadUrl: finalDownloadUrl,
    watermark: primary === withWatermark,
    formats: formats.map((f) => ({
      ...f,
      // La URL final resuelta aplica al formato principal; el segundo
      // formato conserva su URL original.
      download_url: f.download_url === downloadUrl ? finalDownloadUrl : f.download_url,
    })),
  };
}
