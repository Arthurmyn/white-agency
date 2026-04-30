const serverless = require('serverless-http');
const { createApp } = require('../../server');

// Wrap Express app as a Netlify Function
module.exports.handler = serverless(createApp());
