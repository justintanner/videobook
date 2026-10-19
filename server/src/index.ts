import "./load-env.js";
import { logger } from "./logger.js";
import { installSignalHandlers, startServer } from "./serve.js";

const port = Number(process.env.PORT ?? 3001);
const starting = startServer({ port, ui: true });
installSignalHandlers(starting);
starting
  .then((running) => running.ready)
  .catch((error: unknown) => {
    logger.error("startup-failed", { error, port });
    process.exit(1);
  });
