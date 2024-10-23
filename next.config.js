/** @type {import('next').NextConfig} */
const nextConfig = {
  env: {
    NEXT_PUBLIC_PICOVOICE_ACCESS_KEY:
      process.env.NEXT_PUBLIC_PICOVOICE_ACCESS_KEY,
  },
};

module.exports = nextConfig;
