import { MatrixBot } from "../../src/connections/matrix/bot.ts";
import { required } from "../../src/util/required.ts";

const shouldStart = process.argv[2] === "starts";

const bot = await MatrixBot.login({
  homeserver: required(process.env["SHORE_TEST_HOMESERVER"]),
  userId: "@shore:example.com",
  accessToken: "stopped-bot-token",
});
const started = await bot.start().then(
  () => true,
  () => false,
);
if (started !== shouldStart) {
  throw new Error(`the bot ${started ? "started" : "failed to start"}, against expectation`);
}
if (started) bot.stop();

const sent = await bot.sendText("!room:example.com", "sent after the bot stopped");
if (sent !== undefined) throw new Error(`a stopped bot sent ${sent}`);
