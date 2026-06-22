import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createServer } from 'node:http';
import { z } from 'zod';
import xmlrpc from 'xmlrpc';

const ODOO_URL = process.env.ODOO_URL ?? 'https://lisigruen.at';
const ODOO_DB = process.env.ODOO_DB ?? '';
const ODOO_API_KEY = process.env.ODOO_API_KEY ?? '';
const ODOO_UID = parseInt(process.env.ODOO_USER_ID ?? '2', 10);
const PORT = parseInt(process.env.PORT ?? '3100', 10);

if (!ODOO_DB || !ODOO_API_KEY) {
  console.error('Missing required env vars: ODOO_DB, ODOO_API_KEY');
  process.exit(1);
}

const urlObj = new URL(ODOO_URL);
const isHttps = urlObj.protocol === 'https:';
const xmlrpcOpts = {
  host: urlObj.hostname,
  port: parseInt(urlObj.port, 10) || (isHttps ? 443 : 80),
  path: '/mcp/xmlrpc/object',
};
const objectClient = isHttps
  ? xmlrpc.createSecureClient(xmlrpcOpts)
  : xmlrpc.createClient(xmlrpcOpts);

function executeKw(model, method, args, kwargs = {}) {
  return new Promise((resolve, reject) => {
    objectClient.methodCall(
      'execute_kw',
      [ODOO_DB, ODOO_UID, ODOO_API_KEY, model, method, args, kwargs],
      (err, result) => (err ? reject(err) : resolve(result)),
    );
  });
}

async function odooRest(path) {
  const res = await fetch(`${ODOO_URL}${path}`, {
    headers: { 'X-API-Key': ODOO_API_KEY },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  return res.json();
}

function text(obj) {
  return [{ type: 'text', text: JSON.stringify(obj, null, 2) }];
}

// Must create a fresh server+transport per request in stateless mode.
async function buildHandler() {
  const server = new McpServer({ name: 'odoo', version: '1.0.0' });

  server.tool('list_models', 'List all MCP-enabled Odoo models', {}, async () => {
    const result = await odooRest('/mcp/models');
    return { content: text(result) };
  });

  server.tool(
    'get_fields',
    'Get field definitions for an Odoo model',
    { model: z.string().describe('Technical model name, e.g. res.partner') },
    async ({ model }) => {
      const result = await executeKw(model, 'fields_get', [], {
        attributes: ['string', 'type', 'required', 'readonly', 'relation'],
      });
      return { content: text(result) };
    },
  );

  server.tool(
    'search_read',
    'Search and read records from an Odoo model',
    {
      model: z.string().describe('Technical model name, e.g. res.partner'),
      domain: z.array(z.unknown()).default([]).describe('Odoo domain, e.g. [["active","=",true]]'),
      fields: z.array(z.string()).default([]).describe('Fields to return; empty = all stored fields'),
      limit: z.number().int().min(1).max(200).default(20).describe('Max records'),
      offset: z.number().int().min(0).default(0).describe('Pagination offset'),
    },
    async ({ model, domain, fields, limit, offset }) => {
      const result = await executeKw(model, 'search_read', [domain], { fields, limit, offset });
      return { content: text(result) };
    },
  );

  server.tool(
    'execute_kw',
    'Call an arbitrary Odoo model method via execute_kw',
    {
      model: z.string().describe('Technical model name, e.g. res.partner'),
      method: z.string().describe('Odoo model method name, e.g. search_read'),
      args: z.array(z.unknown()).default([]).describe('Positional arguments for the method'),
      kwargs: z.record(z.unknown()).default({}).describe('Keyword arguments for the method'),
    },
    async ({ model, method, args, kwargs }) => {
      const result = await executeKw(model, method, args, kwargs);
      return { content: text(result) };
    },
  );

  server.tool(
    'create_record',
    'Create a new record in an Odoo model',
    {
      model: z.string().describe('Technical model name'),
      values: z.record(z.unknown()).describe('Field values for the new record'),
    },
    async ({ model, values }) => {
      const id = await executeKw(model, 'create', [values]);
      return { content: text({ created_id: id }) };
    },
  );

  server.tool(
    'update_records',
    'Update existing records in an Odoo model',
    {
      model: z.string().describe('Technical model name'),
      ids: z.array(z.number().int()).describe('Record IDs to update'),
      values: z.record(z.unknown()).describe('Field values to set'),
    },
    async ({ model, ids, values }) => {
      const ok = await executeKw(model, 'write', [ids, values]);
      return { content: text({ success: ok }) };
    },
  );

  server.tool(
    'delete_records',
    'Delete records from an Odoo model (irreversible)',
    {
      model: z.string().describe('Technical model name'),
      ids: z.array(z.number().int()).describe('Record IDs to delete'),
    },
    async ({ model, ids }) => {
      const ok = await executeKw(model, 'unlink', [ids]);
      return { content: text({ success: ok }) };
    },
  );

  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await server.connect(transport);
  return transport;
}

const httpServer = createServer(async (req, res) => {
  if (req.url !== '/mcp') {
    res.writeHead(404).end('Not found');
    return;
  }
  try {
    let parsedBody;
    if (req.method === 'POST') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      try {
        parsedBody = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        // leave undefined
      }
    }
    const transport = await buildHandler();
    await transport.handleRequest(req, res, parsedBody);
  } catch (err) {
    console.error('Request error:', err);
    if (!res.headersSent) res.writeHead(500).end(String(err));
  }
});

httpServer.listen(PORT, '127.0.0.1', () => {
  console.log(`Odoo MCP adapter → http://127.0.0.1:${PORT}/mcp`);
  console.log(`  ODOO_URL=${ODOO_URL}  DB=${ODOO_DB}  UID=${ODOO_UID}`);
});
