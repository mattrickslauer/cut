// The two Alibaba Function Compute backends. The browser calls these directly; each holds
// the DashScope (Qwen) key server-side. Defaults point at the live deployed functions so the
// app works with zero configuration — override with NEXT_PUBLIC_* env for your own deploys.

export const PERCEIVE_URL =
  process.env.NEXT_PUBLIC_PERCEIVE_URL ??
  "https://cut-perceive-xfdwmitvbk.ap-southeast-1.fcapp.run";

export const AUDITION_URL =
  process.env.NEXT_PUBLIC_AUDITION_URL ??
  "https://cut-audition-htjhmbyvbv.ap-southeast-1.fcapp.run";
