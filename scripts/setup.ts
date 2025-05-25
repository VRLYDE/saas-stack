import { execSync, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import { default as fs } from "node:fs";
import os from "node:os";
import { default as path } from "node:path";
import { cancel, intro, outro, select, spinner, text } from "@clack/prompts";
import { default as toml } from "@iarna/toml";

// Function to execute shell commands
function executeCommand(command: string) {
  console.log(`\x1b[33m${command}\x1b[0m`);
  try {
    // Add `LC_ALL=en_US.UTF-8` and `LANG=en_US.UTF-8` to ensure consistent encoding for command output.
    // This helps prevent issues with character encoding when parsing command output,
    // especially in environments where the default locale might not be UTF-8.

    // Create a compatible environment object for execSync
    const envVars = { ...process.env } as any;
    envVars.LC_ALL = "en_US.UTF-8";
    envVars.LANG = "en_US.UTF-8";

    return execSync(command, {
      encoding: "utf-8",
      env: envVars,
    });
  } catch (error: any) {
    // Log the error output for better debugging if a command fails.
    console.error(
      `\x1b[31mError executing command: ${command}\x1b[0m\n${
        error.stdout || error.stderr || error.message
      }`
    );
    return { error: true, message: error.stdout || error.stderr };
  }
}

// Function to prompt user for input using @clack/prompts
async function prompt(message: string, defaultValue: string): Promise<string> {
  return (await text({
    message: `${message} (${defaultValue}):`,
    placeholder: defaultValue,
    defaultValue,
  })) as string;
}

// Function to extract account IDs from `wrangler whoami` output
function extractAccountDetails(output: string): { name: string; id: string }[] {
  const lines = output.split("\n");
  const accountDetails: { name: string; id: string }[] = [];

  for (const line of lines) {
    const isValidLine =
      line.trim().startsWith("│ ") && line.trim().endsWith(" │");

    if (isValidLine) {
      const regex = /\b[a-f0-9]{32}\b/g;
      const matches = line.match(regex);

      if (matches && matches.length === 1) {
        const accountName = line.split("│ ")[1]?.trim();
        const accountId = matches[0].replace("│ ", "").replace(" │", "");
        if (accountName === undefined || accountId === undefined) {
          console.error(
            "\x1b[31mError extracting account details from wrangler whoami output.\x1b[0m"
          );
          // cancel("Operation cancelled due to parsing error."); // Clack's cancel might not be available here
          process.exit(1);
        }
        accountDetails.push({ name: accountName, id: accountId });
      }
    }
  }

  return accountDetails;
}

// Function to prompt for account ID if there are multiple accounts
async function promptForAccountId(
  accounts: { name: string; id: string }[]
): Promise<string> {
  if (accounts.length === 1) {
    const account = accounts[0];
    if (!account || !account.id) {
      console.error(
        "\x1b[31mNo valid account found or account ID is missing. Please run `wrangler login`.\x1b[0m"
      );
      cancel("Operation cancelled.");
      process.exit(1); // Ensure exit after cancel
    }
    return account.id;
  }
  if (accounts.length > 1) {
    const options = accounts.map((account) => ({
      value: account.id,
      label: account.name,
      hint: `ID: ${account.id}`, // Add hint for clarity
    }));
    const selectedAccountId = await select({
      message: "Select a Cloudflare account to use:",
      options,
    });

    if (typeof selectedAccountId !== "string") {
      // Handle case where user cancels selection (Ctrl+C)
      console.log("\x1b[33mAccount selection cancelled.\x1b[0m");
      cancel("Operation cancelled.");
      process.exit(1); // Ensure exit after cancel
    }
    return selectedAccountId;
  }
  // This case should ideally be caught earlier, but it's a fallback.
  console.error(
    "\x1b[31mNo accounts found. Please run `wrangler login`.\x1b[0m"
  );
  cancel("Operation cancelled.");
  process.exit(1); // Ensure exit after cancel
}

// Type-safe helper function to handle array filtering
function safeArrayFilter<T>(value: any, filterFn: (item: T) => boolean): T[] {
  if (Array.isArray(value)) {
    return value.filter(filterFn);
  }
  return [];
}

// Global variable for database name, used across functions
let dbName: string;
// Global variable for R2 bucket name
let bucketR2Name: string;
// Global variable for the application name, used for wrangler.toml
let appName: string;

// Function to install necessary dependencies for Cloudflare Workers + Next.js
async function installDependencies() {
  intro("Installing dependencies for Cloudflare Workers + Next.js...");
  const installSpinner = spinner();
  installSpinner.start(
    "Adding @opennextjs/cloudflare and ensuring wrangler is up-to-date..."
  );

  // Install @opennextjs/cloudflare
  const openNextInstallOutput = executeCommand(
    "bun add @opennextjs/cloudflare@latest"
  );
  if (
    typeof openNextInstallOutput !== "string" ||
    openNextInstallOutput.includes("error:")
  ) {
    installSpinner.stop("Failed to install @opennextjs/cloudflare.", 1);
    console.error(
      "\x1b[31mError installing @opennextjs/cloudflare. Please check the output above and try manually.\x1b[0m"
    );
    cancel("Operation cancelled due to dependency installation failure.");
    process.exit(1);
  }

  // Wrangler is expected to be a dev dependency, ensure it.
  // package.json already lists wrangler, so this mostly ensures it's noted.
  // A `bun add -d wrangler@latest` could be used if we want to force update.
  installSpinner.message(
    "Ensuring wrangler is available (expected in devDependencies)..."
  );
  // No specific command here as `bun install` (run before `setup`) should handle it.

  installSpinner.stop(
    "@opennextjs/cloudflare added. Wrangler should be in devDependencies."
  );
  outro("Dependency check completed.");
}

// Function to create/update wrangler.toml for Cloudflare Workers and Next.js
async function configureWorkerSettingsInWranglerToml() {
  intro("Configuring wrangler.toml for Cloudflare Workers deployment...");
  const wranglerTomlPath = path.join(__dirname, "..", "wrangler.toml");
  let wranglerToml: toml.JsonMap;

  try {
    const wranglerTomlContent = fs.readFileSync(wranglerTomlPath, "utf-8");
    wranglerToml = toml.parse(wranglerTomlContent) as toml.JsonMap; // Added type assertion
  } catch (error) {
    console.error(
      `\x1b[31mError reading wrangler.toml at ${wranglerTomlPath}: ${error}\x1b[0m`
    );
    console.log(
      "\x1b[33mMake sure a wrangler.toml file exists at the project root.\x1b[0m"
    );
    cancel("Operation cancelled.");
    process.exit(1); // Ensure exit
  }

  // Prompt for application name, defaulting to current directory name
  const defaultAppName = path.basename(process.cwd());
  appName = await prompt(
    "Enter the name for your Cloudflare Workers application",
    (wranglerToml.name as string) || defaultAppName // Use existing name if available
  );

  // Update wrangler.toml for Next.js on Cloudflare Workers
  // Set the application name
  wranglerToml.name = appName;

  // Set the main entry point for the worker, as per @opennextjs/cloudflare
  wranglerToml.main = ".open-next/worker.js";

  // Set compatibility date and flags for Node.js compatibility
  // Recommended date for @opennextjs/cloudflare features.
  // The Next.js on Workers guide example uses "2025-03-25".
  // The guide text says "set your compatibility date to `2024-09-23` or later".
  // Let's use "2025-03-25" to align with the guide's TOML/JSONC example.
  wranglerToml.compatibility_date = "2025-03-25";
  wranglerToml.compatibility_flags = ["nodejs_compat"];

  // Remove 'pages_build_output_dir' as it's for Cloudflare Pages and not used by OpenNext
  if (
    Object.prototype.hasOwnProperty.call(wranglerToml, "pages_build_output_dir")
  ) {
    delete wranglerToml.pages_build_output_dir;
    console.log(
      "\x1b[33mRemoved 'pages_build_output_dir' from wrangler.toml (Pages-specific).\x1b[0m"
    );
  }

  // Configure static assets serving for OpenNext
  // This tells Cloudflare Workers where to find static assets built by OpenNext
  // and how to serve them. The binding "ASSETS" is used by the OpenNext worker.
  wranglerToml.assets = {
    binding: "ASSETS", // Binding name used by the worker to access static assets
    directory: ".open-next/assets", // Directory containing static assets after `opennextjs-cloudflare build`
  };

  // Ensure placement mode is set, "smart" is a good default.
  if (!wranglerToml.placement) {
    wranglerToml.placement = { mode: "smart" };
  }

  try {
    const updatedToml = toml.stringify(wranglerToml);
    fs.writeFileSync(wranglerTomlPath, updatedToml);
    console.log(
      `\x1b[33mwrangler.toml updated for Cloudflare Workers (app: ${appName}).\x1b[0m`
    );
  } catch (error) {
    console.error(
      `\x1b[31mError writing updated wrangler.toml: ${error}\x1b[0m`
    );
    cancel("Operation cancelled.");
    process.exit(1); // Ensure exit
  }
  outro("wrangler.toml configuration completed.");
}

// Function to create open-next.config.ts for @opennextjs/cloudflare
async function createOpenNextConfig() {
  intro("Setting up OpenNext configuration...");
  const openNextConfigPath = path.join(__dirname, "..", "open-next.config.ts");
  const openNextConfigContent = `// This file configures OpenNext for Cloudflare Workers.
// It defines how your Next.js application should be adapted to run on the Cloudflare edge.
// For more details, visit: https://github.com/sst/open-next
import { defineCloudflareConfig } from "@opennextjs/cloudflare";

export default defineCloudflareConfig({
  //Insert any OpenNext specific configurations here. For example:
  // functionExecutionWeight: 100, // Adjust function execution weight if needed
  // overrides: { ... } // Advanced overrides for server functions, image optimization, etc.
});
`;

  if (fs.existsSync(openNextConfigPath)) {
    console.log(
      "\x1b[33mopen-next.config.ts already exists. Skipping creation.\x1b[0m"
    );
  } else {
    try {
      fs.writeFileSync(openNextConfigPath, openNextConfigContent);
      console.log(
        "\x1b[33mCreated open-next.config.ts for Cloudflare Workers.\x1b[0m"
      );
    } catch (err) {
      console.error(
        `\x1b[31mError creating open-next.config.ts: ${err}\x1b[0m`
      );
      // This might not be critical enough to cancel, but log it.
    }
  }
  outro("OpenNext configuration setup checked/completed.");
}

// Function to create database and update wrangler.toml
async function createDatabaseAndConfigure() {
  intro("Setting up your D1 Database...");
  const defaultDBName = `${path.basename(process.cwd())}-db`;
  dbName = await prompt("Enter the name for your D1 database", defaultDBName);

  let databaseID: string | undefined; // Ensure databaseID can be undefined initially

  const wranglerTomlPath = path.join(__dirname, "..", "wrangler.toml");
  let wranglerToml: toml.JsonMap;

  try {
    const wranglerTomlContent = fs.readFileSync(wranglerTomlPath, "utf-8");
    wranglerToml = toml.parse(wranglerTomlContent) as toml.JsonMap; // Added type assertion
  } catch (err) {
    console.error(
      `\x1b[31mError reading wrangler.toml at ${wranglerTomlPath}: ${err}\x1b[0m`
    );
    cancel("Operation cancelled.");
    process.exit(1); // Ensure exit
  }

  // Run command to create a new D1 database
  // This command will provision a new D1 database on your Cloudflare account.
  const createDbProcess = spawnSync(
    "bunx",
    ["wrangler", "d1", "create", dbName],
    {
      encoding: "utf-8",
      env: Object.assign({}, process.env, {
        LC_ALL: "en_US.UTF-8",
        LANG: "en_US.UTF-8",
      }),
    }
  );

  const creationOutput =
    createDbProcess.status === 0
      ? createDbProcess.stdout
      : {
          error: true,
          message: createDbProcess.stderr || createDbProcess.error?.message,
        };

  if (
    creationOutput === undefined ||
    typeof creationOutput !== "string" ||
    (typeof creationOutput === "object" && "error" in (creationOutput as any))
  ) {
    console.log(
      "\x1b[33mDatabase creation command failed or indicated an issue. This might occur if a database with the same name already exists. Attempting to retrieve existing database info...\x1b[0m"
    );
    // Attempt to get info for an existing database if creation failed.
    const dbInfoOutput = executeCommand(`bunx wrangler d1 info ${dbName}`);
    if (typeof dbInfoOutput === "string") {
      // Regex to find UUID in the d1 info output
      const getInfo =
        dbInfoOutput.match(
          /database_id\s*=\s*"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"/i
        ) ||
        dbInfoOutput.match(
          // Fallback for table format
          /│\s*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\s*│/i
        );
      if (getInfo && getInfo[1]) {
        databaseID = getInfo[1];
        console.log(
          `\x1b[33mFound existing database! ID: ${databaseID}\x1b[0m`
        );
      } else {
        console.error(
          `\x1b[31mFailed to create or find D1 database '${dbName}'. Please check Cloudflare dashboard or wrangler output.\x1b[0m`
        );
        if (
          typeof dbInfoOutput === "object" &&
          "message" in (dbInfoOutput as any)
        ) {
          console.error(
            `\x1b[31mDetails: ${(dbInfoOutput as any).message}\x1b[0m`
          );
        }
        cancel("Operation cancelled due to D1 database error.");
        process.exit(1); // Ensure exit
      }
    } else {
      console.error(
        `\x1b[31mFailed to get D1 database info for '${dbName}'.\x1b[0m`
      );
      cancel("Operation cancelled due to D1 database error.");
      process.exit(1); // Ensure exit
    }
  } else {
    // Extract database ID from the successful creation output
    const matchResult = creationOutput.match(/database_id\s*=\s*"(.*)"/);
    if (matchResult && matchResult[1]) {
      databaseID = matchResult[1];
      console.log(
        `\x1b[32mD1 Database '${dbName}' created successfully. ID: ${databaseID}\x1b[0m`
      );
    } else {
      console.error(
        `\x1b[31mFailed to extract database ID from D1 creation output for '${dbName}'. Output: ${creationOutput}\x1b[0m`
      );
      cancel("Operation cancelled.");
      process.exit(1); // Ensure exit
    }
  }

  if (!databaseID) {
    console.error(
      `\x1b[31mCould not determine Database ID for '${dbName}'. Halting setup.\x1b[0m`
    );
    cancel("Operation cancelled.");
    process.exit(1);
  }

  // Update wrangler.toml with D1 database configuration
  // This section links the D1 database to your Worker via a binding.
  // 'DATABASE' is the binding name used in your Worker code to access the D1 instance.
  // 'migrations_dir' points to where Drizzle ORM (or other tools) store migration files.
  wranglerToml.d1_databases = [
    ...safeArrayFilter<any>(
      wranglerToml.d1_databases,
      (db) => db.binding !== "DATABASE"
    ),
    {
      binding: "DATABASE",
      database_name: dbName,
      database_id: databaseID,
      migrations_dir: "./drizzle",
    } as any,
  ];

  try {
    const updatedToml = toml.stringify(wranglerToml);
    fs.writeFileSync(wranglerTomlPath, updatedToml);
    console.log(
      "\x1b[33mD1 Database configuration updated in wrangler.toml.\x1b[0m"
    );
  } catch (err) {
    console.error(
      `\x1b[31mError writing D1 config to wrangler.toml: ${err}\x1b[0m`
    );
    cancel("Operation cancelled.");
    process.exit(1); // Ensure exit
  }

  outro("D1 Database configuration completed.");
}

async function createBucketR2() {
  intro("Setting up your R2 Bucket (optional)...");
  const createR2 = await select({
    message: "Do you want to set up an R2 bucket for storage?",
    options: [
      { value: true, label: "Yes" },
      { value: false, label: "No, skip R2 setup" },
    ],
  });

  if (createR2 !== true) {
    outro("R2 Bucket setup skipped.");
    return;
  }

  const wranglerTomlPath = path.join(__dirname, "..", "wrangler.toml");
  let wranglerToml: toml.JsonMap;

  try {
    const wranglerTomlContent = fs.readFileSync(wranglerTomlPath, "utf-8");
    wranglerToml = toml.parse(wranglerTomlContent) as toml.JsonMap;
  } catch (error) {
    console.error("\x1b[31mError reading wrangler.toml:", error, "\x1b[0m");
    cancel("Operation cancelled.");
    process.exit(1);
  }

  const bucketR2Spinner = spinner();
  const defaultBucketName = `${appName || path.basename(process.cwd())}-bucket`; // Use appName if set
  bucketR2Name = await prompt(
    "Enter the name for your R2 bucket",
    defaultBucketName
  );
  bucketR2Spinner.start(`Creating R2 bucket '${bucketR2Name}'...`);

  // Create R2 bucket. This command provisions a new R2 bucket on Cloudflare.
  const r2CreationOutput = executeCommand(
    `wrangler r2 bucket create ${bucketR2Name}`
  );

  if (
    typeof r2CreationOutput !== "string" ||
    (typeof r2CreationOutput === "object" &&
      "error" in (r2CreationOutput as any))
  ) {
    bucketR2Spinner.stop(
      "R2 bucket creation command failed or indicated an issue.",
      1
    );
    console.log(
      "\x1b[33mThis might occur if an R2 bucket with the same name already exists globally or in your account.\\x1b[0m"
    );
    // Unlike D1, R2 names are globally unique, so 'info' might not be useful.
    // We'll proceed to configure it in wrangler.toml assuming it might exist or user will resolve.
    console.log(
      "\x1b[33mContinuing to update wrangler.toml with this bucket name.\x1b[0m"
    );
  } else {
    bucketR2Spinner.stop(
      `R2 Bucket '${bucketR2Name}' created (or already exists).`
    );
  }

  // Update wrangler.toml with R2 bucket configuration
  // This links the R2 bucket to your Worker via a binding.
  // 'MY_BUCKET' is the binding name used in your Worker code to access the R2 instance.
  wranglerToml.r2_buckets = [
    ...safeArrayFilter<any>(
      wranglerToml.r2_buckets,
      (bucket) => bucket.binding !== "MY_BUCKET"
    ),
    {
      binding: "MY_BUCKET",
      bucket_name: bucketR2Name,
    } as any,
  ];

  try {
    const updatedToml = toml.stringify(wranglerToml);
    fs.writeFileSync(wranglerTomlPath, updatedToml);
    console.log(
      "\x1b[33mR2 Bucket configuration updated in wrangler.toml.\x1b[0m"
    );
  } catch (error) {
    console.error(
      "\x1b[31mError writing R2 config to wrangler.toml:",
      error,
      "\x1b[0m"
    );
    cancel("Operation cancelled.");
    process.exit(1);
  }

  outro("R2 Bucket configuration completed.");
}

// Function to prompt for Google client credentials and update .dev.vars
async function promptForGoogleClientCredentials() {
  intro("Configuring Authentication (Google OAuth)...");

  const devVarsPath = path.join(__dirname, "..", ".dev.vars");
  let devVarsContent = "";

  if (fs.existsSync(devVarsPath)) {
    devVarsContent = fs.readFileSync(devVarsPath, "utf-8");
  }

  // Check if Google creds are already set
  if (
    devVarsContent.includes("AUTH_GOOGLE_ID=") &&
    devVarsContent.includes("AUTH_GOOGLE_SECRET=")
  ) {
    console.log(
      "\x1b[33mGoogle OAuth credentials already found in .dev.vars. Skipping prompt.\x1b[0m"
    );
    outro("Authentication setup checked.");
    return;
  }

  console.log(
    "\x1b[36mSet up Google OAuth 2.0 for authentication:\n" +
      "1. Go to Google Cloud Console: https://console.cloud.google.com/\n" +
      "2. Create a new project or select an existing one.\n" +
      "3. Navigate to 'APIs & Services' > 'OAuth consent screen'.\n" +
      "   - Configure the consent screen (User Type: External, fill required app info).\n" +
      "4. Go to 'APIs & Services' > 'Credentials'.\n" +
      "   - Click '+ CREATE CREDENTIALS' > 'OAuth client ID'.\n" +
      "   - Application type: 'Web application'.\n" +
      "   - Add Authorized JavaScript origins (for local dev and production):\n" +
      "     - http://localhost:3000 (or your dev port)\n" +
      "     - Your production domain (e.g., https://your-app.workers.dev or https://yourcustomdomain.com)\n" +
      "   - Add Authorized redirect URIs:\n" +
      "     - http://localhost:3000/api/auth/callback/google\n" +
      "     - Your production domain + /api/auth/callback/google (e.g., https://your-app.workers.dev/api/auth/callback/google)\n" +
      "5. Copy the 'Client ID' and 'Client secret'.\x1b[0m"
  );

  const clientId = await prompt(
    "Enter your Google Client ID (leave empty to skip)",
    ""
  );
  const clientSecret = await prompt(
    "Enter your Google Client Secret (leave empty to skip)",
    ""
  );

  let newVars = "";
  if (clientId && !devVarsContent.includes("AUTH_GOOGLE_ID=")) {
    newVars += `AUTH_GOOGLE_ID=${clientId}\n`;
  }
  if (clientSecret && !devVarsContent.includes("AUTH_GOOGLE_SECRET=")) {
    newVars += `AUTH_GOOGLE_SECRET=${clientSecret}\n`;
  }

  if (newVars) {
    try {
      fs.appendFileSync(devVarsPath, newVars); // Append to preserve other vars
      console.log(
        "\x1b[33mGoogle OAuth credentials added/updated in .dev.vars.\x1b[0m"
      );
    } catch (error) {
      console.error(
        `\x1b[31mError updating .dev.vars with Google credentials: ${error}\x1b[0m`
      );
      // Not critical enough to cancel, but log it.
    }
  } else if (!clientId && !clientSecret) {
    console.log("\x1b[33mGoogle OAuth setup skipped by user.\x1b[0m");
  }

  outro("Authentication setup for Google OAuth completed.");
}

// Function to generate a secure random 32-character string
function generateSecureRandomString(length: number): string {
  return crypto
    .randomBytes(Math.ceil(length / 2))
    .toString("hex")
    .slice(0, length);
}

// Function to update .dev.vars with AUTH_SECRET for NextAuth.js
async function updateDevVarsWithAuthSecret() {
  intro("Configuring NextAuth.js secret...");
  const devVarsPath = path.join(__dirname, "..", ".dev.vars");
  let devVarsContent = "";

  if (fs.existsSync(devVarsPath)) {
    devVarsContent = fs.readFileSync(devVarsPath, "utf-8");
  }

  if (devVarsContent.includes("AUTH_SECRET=")) {
    console.log(
      "\x1b[33mAUTH_SECRET already exists in .dev.vars. Skipping generation.\x1b[0m"
    );
  } else {
    // Generate a secure secret for NextAuth.js, crucial for JWT signing, etc.
    const secret = generateSecureRandomString(32);
    try {
      // Append to preserve other vars and add a newline if file is not empty
      const contentToAppend =
        (devVarsContent.endsWith("\n") || devVarsContent === "" ? "" : "\n") +
        `AUTH_SECRET=${secret}\n`;
      fs.appendFileSync(devVarsPath, contentToAppend);
      console.log(
        "\x1b[33mGenerated and appended AUTH_SECRET to .dev.vars file.\x1b[0m"
      );
    } catch (error) {
      console.error(
        `\x1b[31mError updating .dev.vars with AUTH_SECRET: ${error}\x1b[0m`
      );
      // Not critical enough to cancel.
    }
  }
  outro("NextAuth.js secret configuration checked/completed.");
}

// Function to run database migrations using Drizzle Kit
async function runDatabaseMigrations(currentDbName: string) {
  if (!currentDbName) {
    console.log("\x1b[33mDatabase name not set, skipping migrations.\x1b[0m");
    return;
  }
  intro(`Running D1 Database Migrations for '${currentDbName}'...`);

  const migrationSpinner = spinner();

  migrationSpinner.start(
    "Generating database schema migration files (if any changes)..."
  );
  // This command introspects your Drizzle schema and generates SQL migration files.
  const generateOutput = executeCommand("bunx drizzle-kit generate");
  if (typeof generateOutput === "object" && generateOutput.error) {
    migrationSpinner.stop("Schema generation step failed or had issues.", 1);
    console.error(
      "\x1b[31mError during `drizzle-kit generate`:\\x1b[0m",
      generateOutput.message
    );
    // Decide if this is critical enough to stop. For now, just warn.
  } else {
    migrationSpinner.message(
      "Schema generation completed (or no changes detected)."
    );
  }

  // Apply migrations to the local D1 database (used for `wrangler dev`)
  // This command executes the generated SQL migrations against your local D1 instance.
  migrationSpinner.start(
    `Applying migrations to local D1 database '${currentDbName}'...`
  );
  const localMigrateOutput = executeCommand(
    `bunx wrangler d1 migrations apply "${currentDbName}" --local`
  );
  if (typeof localMigrateOutput === "object" && localMigrateOutput.error) {
    migrationSpinner.stop("Local D1 migration failed.", 1);
    console.error(
      "\x1b[31mError applying local D1 migrations:\\x1b[0m",
      localMigrateOutput.message
    );
    // It's important that local migrations succeed for development.
    cancel("Operation cancelled due to local migration failure.");
    process.exit(1);
  } else {
    migrationSpinner.message(
      `Local D1 migrations for '${currentDbName}' completed.`
    );
  }

  // Apply migrations to the remote D1 database (production)
  // This command executes migrations against your provisioned D1 database on Cloudflare.
  migrationSpinner.start(
    `Applying migrations to remote D1 database '${currentDbName}'...`
  );
  const remoteMigrateOutput = executeCommand(
    `bunx wrangler d1 migrations apply "${currentDbName}" --remote`
  );
  if (typeof remoteMigrateOutput === "object" && remoteMigrateOutput.error) {
    migrationSpinner.stop("Remote D1 migration failed.", 1);
    console.error(
      "\x1b[31mError applying remote D1 migrations:\\x1b[0m",
      remoteMigrateOutput.message
    );
    console.warn(
      "\x1b[33mPlease check the error and apply remote migrations manually if needed.\\x1b[0m"
    );
    // Depending on policy, this could be a cancel(), but for now, warn.
  } else {
    migrationSpinner.stop(
      `Remote D1 migrations for '${currentDbName}' completed.`
    );
  }

  outro("D1 Database migrations process finished.");
}

// Helper function to set environment variable instruction (not directly executable by script)
function suggestEnvVariableSetup(name: string, value: string) {
  const platform = os.platform();
  let exportCmd: string;

  if (platform === "win32") {
    // For PowerShell:
    // $env:CLOUDFLARE_ACCOUNT_ID="your_account_id"
    // For Command Prompt:
    // set CLOUDFLARE_ACCOUNT_ID=your_account_id
    exportCmd = `set ${name}=${value} (Command Prompt) or $env:${name}="${value}" (PowerShell)`;
  } else {
    // For bash/zsh:
    exportCmd = `export ${name}="${value}"`;
  }

  console.error(
    `\x1b[31mMissing Cloudflare Account ID. Please set the ${name} environment variable.\x1b[0m`
  );
  console.log(`\x1b[33mRun this command in your terminal: ${exportCmd}\x1b[0m`);
  console.log(
    "\x1b[33mThen, re-run this setup script: \x1b[1mbun run setup\x1b[0m"
  );
}

// Main setup function
async function main() {
  intro("🚀 Starting VRLY SaaS Stack Setup for Cloudflare Workers 🚀");

  // Step 0: Check Cloudflare Account ID environment variable
  // Operations like D1 creation require CLOUDFLARE_ACCOUNT_ID to be set if wrangler can't infer it.
  if (!process.env.CLOUDFLARE_ACCOUNT_ID) {
    const whoamiSpinner = spinner();
    whoamiSpinner.start("Checking Cloudflare login status and account ID...");
    const whoamiOutput = executeCommand("wrangler whoami");
    if (
      typeof whoamiOutput !== "string" ||
      (typeof whoamiOutput === "object" && "error" in (whoamiOutput as any))
    ) {
      whoamiSpinner.stop("Failed to get Cloudflare account info.", 1);
      console.error(
        "\x1b[31mError running `wrangler whoami`. Ensure you are logged in (`wrangler login`).\x1b[0m"
      );
      if (
        typeof whoamiOutput === "object" &&
        "message" in (whoamiOutput as any)
      ) {
        console.error(
          `\x1b[31mDetails: ${(whoamiOutput as any).message}\x1b[0m`
        );
      }
      cancel("Operation cancelled.");
      process.exit(1);
    }

    const accountDetails = extractAccountDetails(whoamiOutput);
    if (
      accountDetails.length === 0 &&
      !whoamiOutput.includes("associated with an account")
    ) {
      // This case might mean `wrangler whoami` output format changed or no accounts truly found
      whoamiSpinner.stop(
        "Could not identify Cloudflare Account ID automatically.",
        1
      );
      console.error(
        "\x1b[31mCould not automatically determine your Cloudflare Account ID from `wrangler whoami`.\\x1b[0m"
      );
      console.log(
        "\x1b[33mPlease find your Account ID on the Cloudflare dashboard (sidebar, bottom right) and set it as CLOUDFLARE_ACCOUNT_ID environment variable.\\x1b[0m"
      );
      suggestEnvVariableSetup("CLOUDFLARE_ACCOUNT_ID", "your_account_id_here");
      cancel("Operation cancelled. CLOUDFLARE_ACCOUNT_ID must be set.");
      process.exit(1);
    } else if (accountDetails.length > 0) {
      whoamiSpinner.message(
        "Multiple Cloudflare accounts found or single account identified."
      );
      const accountId = await promptForAccountId(accountDetails);
      if (accountId) {
        whoamiSpinner.stop(`Using Account ID: ${accountId}`);
        console.log(
          "\x1b[33mCloudflare Account ID selected. For future runs, you can set this as an environment variable: CLOUDFLARE_ACCOUNT_ID\x1b[0m"
        );
        // Set it for the current process to allow D1 creation etc. to succeed.
        process.env.CLOUDFLARE_ACCOUNT_ID = accountId;
      } else {
        whoamiSpinner.stop("Account ID selection failed or was cancelled.", 1);
        cancel("Operation cancelled.");
        process.exit(1);
      }
    } else {
      // If `wrangler whoami` ran but didn't yield usable account details and no CLOUDFLARE_ACCOUNT_ID is set
      whoamiSpinner.stop("Could not determine Cloudflare Account ID.", 1);
      suggestEnvVariableSetup("CLOUDFLARE_ACCOUNT_ID", "your_account_id_here");
      cancel("Operation cancelled. CLOUDFLARE_ACCOUNT_ID must be set.");
      process.exit(1);
    }
  } else {
    console.log(
      `\x1b[33mUsing CLOUDFLARE_ACCOUNT_ID from environment: ${process.env.CLOUDFLARE_ACCOUNT_ID}\x1b[0m`
    );
  }

  try {
    // Step 1: Install/verify dependencies like @opennextjs/cloudflare
    await installDependencies();

    // Step 2: Configure wrangler.toml for Worker (name, main, assets, compat)
    await configureWorkerSettingsInWranglerToml(); // This sets global `appName`

    // Step 3: Create/update D1 Database and configure in wrangler.toml
    await createDatabaseAndConfigure(); // This sets global `dbName`

    // Step 4: Create/update R2 Bucket (optional) and configure in wrangler.toml
    await createBucketR2(); // This sets global `bucketR2Name` if run

    // Step 5: Create open-next.config.ts
    await createOpenNextConfig();

    // Step 6: Setup authentication variables in .dev.vars
    await promptForGoogleClientCredentials();
    await updateDevVarsWithAuthSecret();

    // Step 7: Run database migrations
    // dbName should be set by createDatabaseAndConfigure
    if (dbName) {
      await runDatabaseMigrations(dbName);
    } else {
      console.warn(
        "\x1b[33mSkipping database migrations as dbName was not set.\x1b[0m"
      );
    }

    // Final instructions & next steps
    outro("✅ Setup for Cloudflare Workers completed successfully!");
    console.log("\n\x1b[1mImportant Next Steps:");
    console.log(
      "\x1b[36m1. Update your `package.json` scripts for building and deploying with OpenNext:\x1b[0m"
    );
    console.log(`
  \x1b[32m// Example package.json scripts:
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "worker:build": "opennextjs-cloudflare build",
    "preview": "bun run worker:build && opennextjs-cloudflare preview",
    "deploy": "bun run worker:build && wrangler deploy .open-next/worker.js", // Or use opennextjs-cloudflare deploy
    "lint": "next lint",
    // ... other scripts ...
    "cf-typegen": "wrangler types --env-interface CloudflareEnv env.d.ts" // Keep this if you use it
  }\x1b[0m
`);
    console.log(
      "\x1b[33m   - Remove or replace old Pages-specific scripts (e.g., \`pages:build\`).\x1b[0m"
    );
    console.log(
      "\x1b[36m2. (Optional) Remove \`@cloudflare/next-on-pages\` dependency if it's listed in your \`package.json\`:\\x1b[0m"
    );
    console.log("   \x1b[32mbun remove @cloudflare/next-on-pages\x1b[0m");
    console.log(
      "\x1b[36m3. Review \`wrangler.toml\` and \`.dev.vars\` for correctness.\x1b[0m"
    );
    console.log(
      "\x1b[36m4. To start your local development server (uses Next.js dev server):\x1b[0m"
    );
    console.log("   \x1b[32mbun run dev\x1b[0m");
    console.log(
      "\x1b[36m5. To preview your application locally as it would run on Cloudflare Workers:\x1b[0m"
    );
    console.log("   \x1b[32mbun run preview\x1b[0m");
    console.log(
      "\x1b[36m6. To deploy your application to Cloudflare Workers:\x1b[0m"
    );
    console.log("   \x1b[32mbun run deploy\x1b[0m");

    // The original script ran `bun run dev`. We'll suggest it as part of next steps.
    // spawnSync("bun", ["run", "dev"], { stdio: "inherit" });
  } catch (error: any) {
    console.error(
      `\n\x1b[31m❌ An error occurred during setup: ${error instanceof Error ? error.message : String(error)}\x1b[0m`
    );
    if (error instanceof Error && error.stack) {
      console.error(error.stack);
    }
    cancel("Operation failed. Please check the logs.");
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(
    `\x1b[31mUnhandled error in main: ${e instanceof Error ? e.message : String(e)}\x1b[0m`
  );
  if (e instanceof Error && e.stack) {
    console.error(e.stack);
  }
  cancel("Setup script encountered an unexpected critical error.");
  process.exit(1);
});
