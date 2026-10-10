const handleRequest = require("../server.js");

module.exports = function healthFunction(request, response) {
  request.url = "/api/health";
  return handleRequest(request, response);
};
