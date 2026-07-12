import { fileURLToPath } from "url";
import { dirname } from "path";

const here = dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: false, // the media engines own real device streams; double-mount in dev would grab the camera twice
  // this app lives in a subdirectory of a larger repo — pin the tracing root to itself
  outputFileTracingRoot: here,
};

export default nextConfig;
