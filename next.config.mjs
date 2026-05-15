/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Bundle the Next.js server + only the npm deps it actually uses into
  // .next/standalone — that subdirectory becomes the entire Node.js
  // server payload electron-builder ships inside the Windows installer.
  // No system Node install needed at runtime.
  output: "standalone",
};

export default nextConfig;
