import { discoverEmail } from "../src/services/emailDiscoveryEngine.js";

async function main() {
  console.log("========================================");
  console.log("EMAIL DISCOVERY ENGINE TEST");
  console.log("========================================");

  const result = await discoverEmail({
    firstName: "Patrick",
    lastName: "Collison",
    domain: "stripe.com",

    // Verify only the top 3 candidates.
    maxVerifications: 3,

    // Run SMTP verification.
    verify: true,
  });

  console.log(
    JSON.stringify(
      result,
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error("TEST FAILED");

  console.error(
    error instanceof Error
      ? error.stack ?? error.message
      : error
  );

  process.exit(1);
});
