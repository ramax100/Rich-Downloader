const handleRequest = require("../server.js");

module.exports = function httpGatewayFunction(request, response) {
  request.url = "/api/http";
  return handleRequest(request, response);
};
