
import { config } from "./src/config/config.js";
import { getDatabase } from "./src/database/database.js";
import { getRedis } from "./src/redis/redisClient.js";

console.log("=== Skout Connection Health Check ===");
console.log("Environment:", config.nodeEnv);
console.log("PostgreSQL Host:", new URL(config.database.url).hostname);
console.log("Redis Host:", new URL(config.redis.url).hostname);
console.log("=====================================");

async function testPostgreSQL() {
  console.log("\n📊 Testing PostgreSQL connection...");
  const db = getDatabase();
  const client = await db.connect();
  try {
    const result = await client.query(`
      SELECT 
        current_user, 
        current_database,
        version(),
        NOW() as current_time
    `);
    
    console.log("✅ PostgreSQL connection successful!");
    console.log("  User:", result.rows[0].current_user);
    console.log("  Database:", result.rows[0].current_database);
    console.log("  PostgreSQL Version:", result.rows[0].version.split(" ")[0]);
    console.log("  Server Time:", result.rows[0].current_time);
    return true;
  } finally {
    client.release();
    await db.end();
  }
}

async function testRedis() {
  console.log("\n🔴 Testing Redis connection...");
  const redis = getRedis();
  
  try {
    const pingResult = await redis.ping();
    const info = await redis.info("server");
    const redisVersion = info.match(/redis_version:(\S+)/)?.[1] || "unknown";
    
    // Test write/read
    await redis.set("skout_connection_test", "ok", "EX", 10);
    const testValue = await redis.get("skout_connection_test");
    
    console.log("✅ Redis connection successful!");
    console.log("  PING Response:", pingResult);
    console.log("  Redis Version:", redisVersion);
    console.log("  Write/Read Test:", testValue === "ok" ? "✅ PASSED" : "❌ FAILED");
    return true;
  } finally {
    redis.disconnect();
  }
}

async function runAllTests() {
  const results = { postgres: false, redis: false };
  
  try {
    results.postgres = await testPostgreSQL();
    results.redis = await testRedis();
    
    console.log("\n🎉 All connections are healthy!");
    console.log("=====================================");
    process.exit(0);
  } catch (error) {
    console.error("\n❌ Connection test failed:", error);
    console.log("=====================================");
    process.exit(1);
  }
}

void runAllTests();