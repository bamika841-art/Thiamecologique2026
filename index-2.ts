// supabase-functions/ai-assistant/index.ts
//
// Edge Function Supabase : diagnostic IA (Gemini, vision) pour la photo de
// plante malade dans l'app "Diagnostic Forêts" (THIAM ECOLOGIQUE).
//
// Pourquoi cette fonction existe :
// L'app appelait auparavant https://api.anthropic.com/v1/messages directement
// depuis le navigateur, sans clé API. Cela échoue systématiquement en
// production (CORS + absence d'authentification, et de toute façon une clé
// API ne doit jamais être exposée côté client). Cette fonction fait l'appel
// IA côté serveur, où la clé peut rester secrète.
//
// Configuration requise avant déploiement :
//   1. Obtenir une clé API Gemini sur https://aistudio.google.com/apikey
//   2. La déclarer comme secret Supabase (jamais dans le code) :
//        supabase secrets set GEMINI_API_KEY=xxxxxxxxxxxx
//   3. Déployer :
//        supabase functions deploy ai-assistant
//
// Contrat avec le frontend (voir lancerDiagnosticPlante() dans l'app) :
//   POST body JSON : { systemPrompt, userText, imageBase64, imageMediaType }
//   Réponse 200    : l'objet JSON du diagnostic tel que défini par le schéma
//                    demandé dans systemPrompt (déjà parsé, prêt à l'emploi).
//   Réponse erreur : { error: "QUOTA_DEPASSE" | "SERVEUR_INDISPONIBLE" |
//                      "REPONSE_VIDE" | "REPONSE_MAL_FORMEE" | "REQUETE_INVALIDE" |
//                      "TIMEOUT", detail?: string }
//   Ces codes sont repris tels quels par le frontend pour choisir le message
//   d'erreur affiché à l'utilisateur — ne pas les renommer sans mettre à jour
//   lancerDiagnosticPlante() en parallèle.

const GEMINI_MODEL = "gemini-2.0-flash";
const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY");

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

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }

  if (req.method !== "POST") {
    return json({ error: "REQUETE_INVALIDE", detail: "Méthode non autorisée, POST attendu." }, 405);
  }

  if (!GEMINI_API_KEY) {
    console.error("GEMINI_API_KEY manquante : configurez le secret Supabase avant de déployer.");
    return json({ error: "SERVEUR_INDISPONIBLE", detail: "Clé Gemini non configurée côté serveur." }, 500);
  }

  // deno-lint-ignore no-explicit-any
  let body: any;
  try {
    body = await req.json();
  } catch (_e) {
    return json({ error: "REQUETE_INVALIDE", detail: "Corps JSON invalide." }, 400);
  }

  const { systemPrompt, userText, imageBase64, imageMediaType } = body ?? {};

  if (!imageBase64 || !userText) {
    return json({ error: "REQUETE_INVALIDE", detail: "Champs requis manquants : imageBase64 et userText." }, 400);
  }

  const geminiPayload = {
    system_instruction: systemPrompt ? { parts: [{ text: systemPrompt }] } : undefined,
    contents: [
      {
        role: "user",
        parts: [
          { text: userText },
          { inline_data: { mime_type: imageMediaType || "image/jpeg", data: imageBase64 } },
        ],
      },
    ],
    generationConfig: {
      responseMimeType: "application/json",
      temperature: 0.4,
      maxOutputTokens: 2048,
    },
  };

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 40000);

  try {
    const resp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": GEMINI_API_KEY,
        },
        signal: controller.signal,
        body: JSON.stringify(geminiPayload),
      },
    );

    if (!resp.ok) {
      const errText = await resp.text().catch(() => "");
      console.error("Erreur API Gemini:", resp.status, errText);
      if (resp.status === 429) return json({ error: "QUOTA_DEPASSE" }, 429);
      if (resp.status >= 500) return json({ error: "SERVEUR_INDISPONIBLE" }, 502);
      return json({ error: "REQUETE_INVALIDE", detail: errText.slice(0, 500) }, 400);
    }

    const data = await resp.json();
    const rawText: string =
      data?.candidates?.[0]?.content?.parts
        ?.map((p: { text?: string }) => p.text || "")
        .join("\n") || "";

    if (!rawText.trim()) {
      // Cause fréquente : la réponse a été coupée par un filtre de sécurité Gemini
      // (voir data.candidates[0].finishReason) plutôt qu'une vraie réponse vide.
      const finishReason = data?.candidates?.[0]?.finishReason;
      console.error("Réponse Gemini vide. finishReason:", finishReason);
      return json({ error: "REPONSE_VIDE" }, 502);
    }

    const cleaned = rawText.replace(/```json|```/g, "").trim();
    // deno-lint-ignore no-explicit-any
    let parsed: any;
    try {
      parsed = JSON.parse(cleaned);
    } catch (_e) {
      console.error("JSON Gemini mal formé:", rawText);
      return json({ error: "REPONSE_MAL_FORMEE" }, 502);
    }

    return json(parsed, 200);
  } catch (e) {
    console.error("Erreur appel Gemini:", e);
    if ((e as Error)?.name === "AbortError") return json({ error: "TIMEOUT" }, 504);
    return json({ error: "SERVEUR_INDISPONIBLE" }, 502);
  } finally {
    clearTimeout(timeoutId);
  }
});
