import { Redis } from "@upstash/redis";
import { config } from "./env";

export const redis = new Redis({
  url: config.upstashUrl,
  token: config.upstashToken,
});
