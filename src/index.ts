import { startIndexer } from "./indexer";
import { startServer } from "./server";
import { REFRESH_INTERVAL_MS } from "./config";

startIndexer(REFRESH_INTERVAL_MS);
startServer();
