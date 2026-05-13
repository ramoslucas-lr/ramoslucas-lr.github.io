import { defineConfig } from 'astro/config';
import tailwind from '@astrojs/tailwind';

// Antigravity SSG Engine Configuration
export default defineConfig({
  site: 'https://ramoslucas-lr.github.io',
  integrations: [tailwind()],
  markdown: {
    shikiConfig: {
      // High-performance syntax highlighting using Shiki
      theme: 'dracula',
      wrap: true,
    },
  },
  image: {
    // Media & Performance Settings (Antigravity Core)
    domains: [],
    // Force AVIF & WebP optimization
    service: {
      entrypoint: 'astro/assets/services/sharp',
      config: {
        limitInputPixels: false,
      }
    }
  },
  // Ensure strict SSG output
  output: 'static',
  prefetch: {
    prefetchAll: true,
    defaultStrategy: 'viewport',
  }
});
