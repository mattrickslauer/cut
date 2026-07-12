// One Alibaba Function Compute backend for the whole app (cut-api): the Director's-eye
// perception service and the Audition Room co-star reader, merged into a single scale-to-zero
// function that holds the DashScope (Qwen) key server-side. The browser calls it directly.
// Override with NEXT_PUBLIC_API_URL for your own deploy. (Deploy: backend/api/, `s deploy`.)

export const API_URL =
  process.env.NEXT_PUBLIC_API_URL ??
  "https://cut-api-rjnhudrcgv.ap-southeast-1.fcapp.run";

// Both features now share the one backend; kept as named exports so callers don't churn.
export const PERCEIVE_URL = API_URL;
export const AUDITION_URL = API_URL;
