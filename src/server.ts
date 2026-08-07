import app from "./app.js";

const PORT = Number(process.env.PORT ?? 3001);
const HOST = process.env.HOST ?? "0.0.0.0";

try {
await app.listen({
port: PORT,
host: HOST,
});

app.log.info(
`Email intelligence service listening on ${HOST}:${PORT}`
);
} catch (error) {
app.log.error(error);
process.exit(1);
}
