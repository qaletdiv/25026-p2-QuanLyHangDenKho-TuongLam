const errorHandler = (err, req, res, next) => {
    console.error(`[Error] ${err.message}`);
    const status = err.statusCode || 500;
    res.status(status).json({
        success: false,
        error: err.message || 'Internal Server Error',
        ...(err.details && { details: err.details }),
        stack: process.env.NODE_ENV === 'development' ? err.stack : undefined
    });
};

// Async wrapper to avoid try/catch blocks in every route
const asyncWrap = fn => (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
};

module.exports = { errorHandler, asyncWrap };
