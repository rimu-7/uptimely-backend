import { app } from "../src/index";

export default async function handler(req: any, res: any) {
  res.setHeader("Access-Control-Allow-Origin", "https://uptimely.vercel.app");
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, Accept, X-Requested-With");

  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    return res.end();
  }

  try {
    const protocol = req.headers["x-forwarded-proto"] || "https";
    const host = req.headers.host;
    const fullUrl = `${protocol}://${host}${req.url}`;

    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers || {})) {
      if (value) {
        if (Array.isArray(value)) {
          headers.set(key, value.join(", "));
        } else {
          headers.set(key, value as string);
        }
      }
    }

    let body: any = undefined;
    if (req.method !== "GET" && req.method !== "HEAD" && req.body) {
      body = typeof req.body === "string" ? req.body : JSON.stringify(req.body);
    }

    const webRequest = new Request(fullUrl, {
      method: req.method,
      headers,
      body,
    });

    const webResponse = await app.handle(webRequest);

    res.statusCode = webResponse.status;
    webResponse.headers.forEach((val, key) => {
      res.setHeader(key, val);
    });

    const bodyText = await webResponse.text();
    return res.status(webResponse.status).send(bodyText);
  } catch (err: any) {
    console.error("❌ [Vercel Function Error]", err);
    return res.status(500).json({ error: "Internal Server Error", message: err?.message || err });
  }
}
