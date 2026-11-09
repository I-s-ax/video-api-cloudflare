// Adaptador de extracción para TikTok (API pública móvil Aweme, sin marca de agua).
// Resuelve enlaces cortos (vm.tiktok.com), obtiene el ID del video y consulta
// la API Aweme para el enlace de descarga directa del MP4.

// La identidad (User-Agent) DEBE ser exactamente la misma que usa la app
// de Android al descargar: TikTok asocia la URL temporal a esa identidad y
// la CDN rechaza la descarga (403) si el User-Agent cambia entre la
// consulta a la API y la descarga. Si se cambia aquí, cambiarlo también
// en MainActivity.kt (resolveAndDownload).
const USER_AGENT =
  "Mozilla/5.0 (Linux; Android 13; SM-S908B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/112.0.0.0 Mobile Safari/537.36";

// Android bloquea el tráfico en texto plano (cleartext): si TikTok devuelve
// una URL http://, el DownloadManager la cancela. Forzar siempre https.
const forceHttps = (u: string): string =>
  u.startsWith("http://") ? "https://" + u.slice("http://".length) : u;

// NOTA: el Worker devuelve la URL limpia, sin resolver redirecciones. La
// redirección se resuelve en el teléfono (resolveAndDownload en la app):
// las URLs firmadas de TikTok están atadas a la IP que las pidió, y si el
// Worker resuelve la redirección, la URL final queda firmada con la IP de
// Cloudflare y el teléfono recibe 403. Resuelta en el móvil, la firma es
// con la IP del teléfono.

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

  // 6. Devolver la URL limpia (solo con https forzado). La redirección se
  // resuelve en el teléfono, no aquí: ver nota al inicio del archivo.
  console.log("extract_tiktok", JSON.stringify({
    video_id: videoId,
    source,
    source_host: new URL(downloadUrl).hostname,
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
    download_url: downloadUrl,
    downloadUrl,
    watermark: primary === withWatermark,
    formats,
  };
}
