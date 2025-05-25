// This file configures OpenNext for Cloudflare Workers.
// It defines how your Next.js application should be adapted to run on the Cloudflare edge.
// For more details, visit: https://github.com/sst/open-next
import { defineCloudflareConfig } from "@opennextjs/cloudflare";

export default defineCloudflareConfig({
  //Insert any OpenNext specific configurations here. For example:
  // functionExecutionWeight: 100, // Adjust function execution weight if needed
  // overrides: { ... } // Advanced overrides for server functions, image optimization, etc.
});
