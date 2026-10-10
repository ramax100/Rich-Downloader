const handleRequest = require("../server.js");

module.exports = function aioGatewayFunction(request, response) {
  request.url = "/api/aio";
  return handleRequest(request, response);
};
