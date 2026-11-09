// Adaptador de extracción para TikTok (API pública móvil Aweme, sin marca de agua).
// Resuelve enlaces cortos (vm.tiktok.com), obtiene el ID del video y consulta
// la API Aweme para el enlace de descarga directa del MP4.

const USER_AGENT =
  "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36";

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

  // 3. Consultar la API pública móvil de TikTok (Aweme).
  const apiUrl = `https://api16-normal-c-useast1a.tiktokv.com/aweme/v1/feed/?aweme_id=${videoId}`;
  const apiRes = await fetch(apiUrl, { headers: { "user-agent": USER_AGENT } });
  if (!apiRes.ok) {
    throw new Error("TIKTOK_API_ERROR");
  }
  const data: any = await apiRes.json();
  const aweme = data?.aweme_list?.[0];
  const video = aweme?.video;
  if (!video) {
    throw new Error("VIDEO_NOT_FOUND");
  }

  // 4. Preferir el enlace sin marca de agua (download_addr); si no existe,
  // usar el enlace estándar con marca de agua (play_addr).
  const noWatermark = video?.download_addr?.url_list?.[0] as string | undefined;
  const withWatermark = video?.play_addr?.url_list?.[0] as string | undefined;
  const downloadUrl = noWatermark || withWatermark;
  if (!downloadUrl) {
    throw new Error("DOWNLOAD_URL_NOT_FOUND");
  }

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
    watermark: !noWatermark,
    formats: [
      {
        download_url: downloadUrl,
        format: "mp4",
        quality: `${(video?.height as number) || 0}p`,
        watermark: !noWatermark,
      },
    ],
  };
}
