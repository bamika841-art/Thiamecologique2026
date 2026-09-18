// supabase-functions/ndvi-satellite/index.ts
//
// Edge Function Supabase : calcule le NDVI réel (Sentinel-2, Copernicus) autour
// d'un point (site suivi par l'Observatoire environnemental), via l'API
// Statistical de Sentinel Hub — remplace l'estimation simulée (siteNdvi()) par
// une vraie mesure satellite quand la fonction est déployée et configurée.
//
// Configuration requise avant déploiement :
//   1. Créer un compte Sentinel Hub (gratuit) sur https://www.sentinel-hub.com/
//      puis une "OAuth client" dans le Dashboard (Account → User settings → OAuth clients).
//   2. Déclarer les identifiants comme secrets Supabase (jamais dans le code) :
//        supabase secrets set SENTINEL_HUB_CLIENT_ID=xxxxx
//        supabase secrets set SENTINEL_HUB_CLIENT_SECRET=xxxxx
//   3. Déployer :
//        supabase functions deploy ndvi-satellite
//
// Contrat avec le frontend (voir loadRealNdvi() dans l'app Observatoire) :
//   POST body JSON : { lat, lon }
//   Réponse 200    : { ndvi: number (0 à 1), date: string (AAAA-MM-JJ), cloudCoverPct?: number }
//   Réponse erreur : { error: string }
//
// Méthode : on interroge la Statistical API de Sentinel Hub sur les 30 derniers
// jours, avec un filtre nuages, pour un petit carré (~1 km de côté) centré sur
// le point fourni, et on renvoie le NDVI moyen (bande B08 proche infrarouge,
// bande B04 rouge) de l'acquisition Sentinel-2 la plus récente disponible.

const SENTINEL_TOKEN_URL = "https://services.sentinel-hub.com/oauth/token";
const SENTINEL_STATS_URL = "https://services.sentinel-hub.com/api/v1/statistics";

const CLIENT_ID = Deno.env.get("SENTINEL_HUB_CLIENT_ID");
const CLIENT_SECRET = Deno.env.get("SENTINEL_HUB_CLIENT_SECRET");

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

// evalscript NDVI standard, calculé côté Sentinel Hub à partir des bandes brutes.
const NDVI_EVALSCRIPT = `
//VERSION=3
function setup() {
  return {
    input: [{ bands: ["B04", "B08", "dataMask"] }],
    output: [
      { id: "ndvi", bands: 1 },
      { id: "dataMask", bands: 1 },
    ],
  };
}
function evaluatePixel(s) {
  let ndvi = (s.B08 - s.B04) / (s.B08 + s.B04);
  return { ndvi: [ndvi], dataMask: [s.dataMask] };
}
`;

async function getAccessToken(): Promise<string> {
  const resp = await fetch(SENTINEL_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: CLIENT_ID!,
      client_secret: CLIENT_SECRET!,
    }),
  });
  if (!resp.ok) {
    throw new Error("SENTINEL_AUTH_ECHOUE: " + (await resp.text()).slice(0, 300));
  }
  const data = await resp.json();
  return data.access_token as string;
}

function bboxAround(lat: number, lon: number, halfSideKm = 0.5) {
  // ~111 km par degré de latitude ; approximation suffisante pour un petit carré local.
  const dLat = halfSideKm / 111;
  const dLon = halfSideKm / (111 * Math.cos((lat * Math.PI) / 180));
  return [lon - dLon, lat - dLat, lon + dLon, lat + dLat];
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }
  if (req.method !== "POST") {
    return json({ error: "REQUETE_INVALIDE" }, 405);
  }
  if (!CLIENT_ID || !CLIENT_SECRET) {
    console.error("Identifiants Sentinel Hub manquants : configurez les secrets Supabase avant de déployer.");
    return json({ error: "SERVEUR_INDISPONIBLE", detail: "Identifiants Sentinel Hub non configurés côté serveur." }, 500);
  }

  // deno-lint-ignore no-explicit-any
  let body: any;
  try {
    body = await req.json();
  } catch (_e) {
    return json({ error: "REQUETE_INVALIDE", detail: "Corps JSON invalide." }, 400);
  }

  const { lat, lon } = body ?? {};
  if (typeof lat !== "number" || typeof lon !== "number") {
    return json({ error: "REQUETE_INVALIDE", detail: "lat et lon (nombres) requis." }, 400);
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 25000);

  try {
    const token = await getAccessToken();

    const today = new Date();
    const from = new Date(today.getTime() - 30 * 24 * 3600 * 1000);
    const bbox = bboxAround(lat, lon);

    const statsPayload = {
      input: {
        bounds: {
          bbox,
          properties: { crs: "http://www.opengis.net/def/crs/EPSG/0/4326" },
        },
        data: [
          {
            type: "sentinel-2-l2a",
            dataFilter: { maxCloudCoverage: 40 },
          },
        ],
      },
      aggregation: {
        timeRange: { from: from.toISOString(), to: today.toISOString() },
        aggregationInterval: { of: "P30D" },
        evalscript: NDVI_EVALSCRIPT,
      },
    };

    const resp = await fetch(SENTINEL_STATS_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + token,
      },
      signal: controller.signal,
      body: JSON.stringify(statsPayload),
    });

    if (!resp.ok) {
      const errText = await resp.text().catch(() => "");
      console.error("Erreur Sentinel Hub Statistical API:", resp.status, errText);
      if (resp.status === 429) return json({ error: "QUOTA_DEPASSE" }, 429);
      return json({ error: "SERVEUR_INDISPONIBLE", detail: errText.slice(0, 300) }, 502);
    }

    const data = await resp.json();
    const interval = data?.data?.[0];
    const ndviStats = interval?.outputs?.ndvi?.bands?.B0?.stats;

    if (!ndviStats || typeof ndviStats.mean !== "number") {
      return json({ error: "REPONSE_VIDE", detail: "Aucune acquisition Sentinel-2 exploitable sur les 30 derniers jours (nuages persistants ou zone hors couverture)." }, 502);
    }

    return json({
      ndvi: Math.max(-1, Math.min(1, ndviStats.mean)),
      date: (interval.interval?.to || today.toISOString()).slice(0, 10),
      cloudCoverPct: undefined,
    });
  } catch (e) {
    console.error("Erreur calcul NDVI Sentinel Hub:", e);
    if ((e as Error)?.name === "AbortError") return json({ error: "TIMEOUT" }, 504);
    const msg = (e as Error)?.message || "";
    if (msg.startsWith("SENTINEL_AUTH_ECHOUE")) return json({ error: "SERVEUR_INDISPONIBLE", detail: "Authentification Sentinel Hub refusée — vérifiez les secrets configurés." }, 502);
    return json({ error: "SERVEUR_INDISPONIBLE" }, 502);
  } finally {
    clearTimeout(timeoutId);
  }
});
