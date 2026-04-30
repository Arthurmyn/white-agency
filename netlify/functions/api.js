const serverless = require('serverless-http');
const { createApp } = require('../../server');

const app     = createApp();
const wrapped = serverless(app);

exports.handler = async (event, context) => {
  try {
    return await wrapped(event, context);
  } catch (err) {
    console.error('Function error:', err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
