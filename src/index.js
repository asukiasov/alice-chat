export { ChatHub } from "./chat-hub.js";

export default {
  fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname.startsWith("/api/") || pathname === "/ws") {
      return env.CHAT_HUB.getByName("main").fetch(request);
    }
    return env.ASSETS.fetch(request);
  },
};
