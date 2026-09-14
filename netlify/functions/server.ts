import { app } from "../../src/index";

export const handler = async (event: any, context: any) => {
  const corsHeaders: Record<string, string> = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, Accept, X-Requested-With",
  };

  // Handle preflight OPTIONS request instantly
  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 204,
      headers: corsHeaders,
      body: "",
    };
  }

  try {
    const rawPath = event.path || "/";
    const queryString = event.rawQuery ? `?${event.rawQuery}` : "";
    const protocol = event.headers["x-forwarded-proto"] || "https";
    const host = event.headers.host || "localhost";
    const fullUrl = `${protocol}://${host}${rawPath}${queryString}`;

    const headers = new Headers();
    for (const [key, value] of Object.entries(event.headers || {})) {
      if (value) headers.set(key, value as string);
    }

    let requestBody: any = undefined;
    if (event.body && (event.httpMethod === "POST" || event.httpMethod === "PUT" || event.httpMethod === "PATCH")) {
      requestBody = event.isBase64Encoded
        ? Buffer.from(event.body, "base64")
        : event.body;
    }

    const request = new Request(fullUrl, {
      method: event.httpMethod || "GET",
      headers,
      body: requestBody,
    });

    const response = await app.handle(request);

    const responseHeaders: Record<string, string> = {
      ...corsHeaders,
    };

    response.headers.forEach((val, key) => {
      responseHeaders[key] = val;
    });

    const bodyText = await response.text();

    return {
      statusCode: response.status,
      headers: responseHeaders,
      body: bodyText,
    };
  } catch (err: any) {
    console.error("❌ [Netlify Function Error]", err);
    return {
      statusCode: 500,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ error: "Internal Server Error", message: err?.message || err }),
    };
  }
};
