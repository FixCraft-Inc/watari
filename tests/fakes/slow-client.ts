/**
 * A UI that redraws slowly, in its own process like a real one: it spends
 * 150 ms on every snapshot it receives. Prints one JSON line when it stops.
 */
const [socketPath, marker = "final marker"] = process.argv.slice(2);
if (!socketPath) throw new Error("usage: slow-client <socket> [marker]");
let carry = "";
let sawMarker = false;
let closed = false;
const finish = () => {
  process.stdout.write(`${JSON.stringify({ closed, sawMarker })}\n`);
  process.exit(0);
};
const socket = await Bun.connect({
  unix: socketPath,
  socket: {
    data(_socket, data) {
      const lines = (carry + data.toString()).split("\n");
      carry = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith('{"type":"state_changed"')) continue;
        if (line.includes(marker)) sawMarker = true;
        const until = Date.now() + 150;
        while (Date.now() < until) { /* one full redraw per snapshot */ }
      }
      if (sawMarker) finish();
    },
    close() {
      closed = true;
      finish();
    },
  },
});
socket.write(`${JSON.stringify({ id: "n1", type: "negotiate", versions: [2] })}\n`);
setTimeout(finish, 25_000);

export {};
