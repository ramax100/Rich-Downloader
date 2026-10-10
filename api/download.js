const handleRequest = require("../server.js");

module.exports = function downloadGatewayFunction(request, response) {
  request.url = "/api/download";
  return handleRequest(request, response);
};
