import { OmniFlash } from "omniflash-sdk";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

async function run() {
  const authPath = join(homedir(), ".pi", "agent", "auth.json");
  const content = await readFile(authPath, "utf8");
  const auth = JSON.parse(content);
  const token = auth["google-antigravity"].access;

  const client = new OmniFlash({ apiKey: token });
  try {
    const res = await client.run({
      model_id: "nano-banana-2",
      prompt: "A neon pink demon lord",
      aspect_ratio: "1:1"
    });
    console.log("Success:", res);
  } catch(e: any) {
    console.error("Error:", e.message);
  }
}
run();
