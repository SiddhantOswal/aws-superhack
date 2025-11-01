import express, { Request, Response } from 'express';

import { handler as shelfwareHandler } from '../lambdas/shelfware-report/src/index';
import { handler as underbillingHandler } from '../lambdas/underbilling-report/src/index';
import { handler as policyEvaluatorHandler } from '../lambdas/policy-evaluator/src/index';
import { handler as approveActionHandler } from '../lambdas/approve-action/src/index';
import { handler as qbrReportHandler } from '../lambdas/qbr-pdf/src/index';
import { handler as athenaBootstrapHandler } from '../lambdas/athena-bootstrap/src/index';

const app = express();
app.use(express.json());

// GET / - Root endpoint with API documentation
app.get('/', (_req: Request, res: Response) => {
  res.json({
    name: 'MSP Growth OS - Mock API',
    version: '0.1.0',
    status: 'running',
    baseUrl: 'http://localhost:3000',
    endpoints: {
      'GET /': 'This endpoint - API documentation',
      'GET /health': 'Health check endpoint',
      'POST /admin/bootstrap': 'Initialize Athena views (AWS only)',
      'GET /ledger': 'Get actions ledger (add ?client_id=C001 to filter)',
      'GET /reports/shelfware': 'Get shelfware analysis report',
      'GET /reports/underbilling': 'Get underbilling analysis report',
      'POST /policies/evaluate': 'Manually trigger policy evaluation',
      'POST /actions/:id/approve': 'Approve an action (requires action_id)',
      'POST /qbr/pdf': 'Generate QBR PDF report (requires client_id and period)',
    },
    exampleRequests: {
      ledger: 'http://localhost:3000/ledger',
      shelfware: 'http://localhost:3000/reports/shelfware',
      underbilling: 'http://localhost:3000/reports/underbilling',
      approve: 'POST http://localhost:3000/actions/12345/approve with body: {}',
      qbr: 'POST http://localhost:3000/qbr/pdf with body: {"client_id":"C001","period":"2025-09"}',
    },
  });
});

// GET /health - Health check endpoint
app.get('/health', (_req: Request, res: Response) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  });
});

// POST /admin/bootstrap → athenaBootstrap.handler()
app.post('/admin/bootstrap', async (_req: Request, res: Response) => {
  try {
    const result = await athenaBootstrapHandler();
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Internal error' });
  }
});

// GET /ledger → approveAction.handler() with GET method
app.get('/ledger', async (req: Request, res: Response) => {
  try {
    const event = {
      httpMethod: 'GET',
      path: req.path,
      queryStringParameters: req.query as any,
      body: null,
    };
    const lambdaResp: any = await approveActionHandler(event);
    if (lambdaResp && typeof lambdaResp.statusCode === 'number') {
      if (lambdaResp.headers) res.set(lambdaResp.headers);
      res.status(lambdaResp.statusCode).send(lambdaResp.body);
    } else {
      res.json(lambdaResp);
    }
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Internal error' });
  }
});

// GET /reports/shelfware → shelfwareReport.handler()
app.get('/reports/shelfware', async (_req: Request, res: Response) => {
  try {
    const result = await shelfwareHandler();
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Internal error' });
  }
});

// GET /reports/underbilling → underbillingReport.handler()
app.get('/reports/underbilling', async (_req: Request, res: Response) => {
  try {
    const result = await underbillingHandler();
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Internal error' });
  }
});

// POST /policies/evaluate → policyEvaluator.handler() (Local testing only)
app.post('/policies/evaluate', async (_req: Request, res: Response) => {
  try {
    const result = await policyEvaluatorHandler();
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Internal error' });
  }
});

// POST /actions/:id/approve → approveAction.handler()
app.post('/actions/:id/approve', async (req: Request, res: Response) => {
  try {
    const event = {
      httpMethod: 'POST',
      path: req.path,
      pathParameters: { action_id: req.params.id },
      body: JSON.stringify(req.body || {}),
    };
    const lambdaResp: any = await approveActionHandler(event);
    if (lambdaResp && typeof lambdaResp.statusCode === 'number') {
      if (lambdaResp.headers) res.set(lambdaResp.headers);
      res.status(lambdaResp.statusCode).send(lambdaResp.body);
    } else {
      res.json(lambdaResp);
    }
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Internal error' });
  }
});

// POST /qbr/pdf → qbrReport.handler(req.body) (matches AWS endpoint)
app.post('/qbr/pdf', async (req: Request, res: Response) => {
  try {
    const event = { body: JSON.stringify(req.body || {}) };
    const result = await qbrReportHandler(event);
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Internal error' });
  }
});

// Legacy endpoint: POST /qbr/report (for backwards compatibility)
app.post('/qbr/report', async (req: Request, res: Response) => {
  try {
    const event = { body: JSON.stringify(req.body || {}) };
    const result = await qbrReportHandler(event);
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Internal error' });
  }
});

const PORT = 3000;
app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log('🚀 Mock API running on http://localhost:3000');
  // eslint-disable-next-line no-console
  console.log('📋 Available endpoints:');
  // eslint-disable-next-line no-console
  console.log('   POST /admin/bootstrap');
  // eslint-disable-next-line no-console
  console.log('   GET  /ledger');
  // eslint-disable-next-line no-console
  console.log('   GET  /reports/shelfware');
  // eslint-disable-next-line no-console
  console.log('   GET  /reports/underbilling');
  // eslint-disable-next-line no-console
  console.log('   POST /policies/evaluate (local only)');
  // eslint-disable-next-line no-console
  console.log('   POST /actions/:id/approve');
  // eslint-disable-next-line no-console
  console.log('   POST /qbr/pdf');
  // eslint-disable-next-line no-console
  console.log('');
  // eslint-disable-next-line no-console
  console.log('💡 Visit http://localhost:3000/ to see all available endpoints');
});

export default app;


