let handler;

function getHandler() {
  if (handler) return handler;
  const serverless    = require('serverless-http');
  const { createApp } = require('../../server');
  handler = serverless(createApp());
  return handler;
}

exports.handler = async (event, context) => {
  try {
    return await getHandler()(event, context);
  } catch (err) {
    console.error('[api] crashed:', err.message, err.stack);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: err.message }),
    };
  }
};
