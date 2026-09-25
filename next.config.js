/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,

  // Expose mock-data flag to the browser bundle.
  // Set NEXT_PUBLIC_USE_MOCK_DATA=true in .env.local to run without a backend.
  env: {
    NEXT_PUBLIC_USE_MOCK_DATA: process.env.NEXT_PUBLIC_USE_MOCK_DATA ?? "true",
  },

  // Leaflet uses window and self at module level; exclude it from SSR.
  webpack(config) {
    return config;
  },
};

module.exports = nextConfig;
