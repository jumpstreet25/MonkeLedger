import { startIndexer } from "./indexer";
import { startServer } from "./server";
import { POLL_INTERVAL_MS, REFRESH_INTERVAL_MS } from "./config";

startIndexer(POLL_INTERVAL_MS, REFRESH_INTERVAL_MS);
startServer();
