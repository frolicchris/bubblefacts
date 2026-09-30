import fs from "fs";
import os from "os";
import path from "path";

// Facts marked wrong during tests go to a throwaway folder, not the repo's data/.
process.env.BUBBLEFACTS_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "bubblefacts-test-"));

jest.spyOn(console, "log").mockImplementation(() => undefined);
jest.spyOn(console, "warn").mockImplementation(() => undefined);
