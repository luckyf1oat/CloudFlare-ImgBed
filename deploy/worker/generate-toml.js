/**
 * 自动创建 Cloudflare 资源并生成 wrangler.toml
 * 
 * 使用 Cloudflare API 直接创建资源（无需 wrangler CLI 的 JSON 输出支持）
 * 
 * 功能：
 * 1. 自动创建 KV 命名空间 `img_url`（如果不存在）
 * 2. 自动创建 R2 存储桶 `img_r2`（如果不存在）
 * 3. 自动获取并写入绑定 ID
 * 4. 支持自定义前缀（用于多环境部署）
 * 
 * 环境变量：
 *   CLOUDFLARE_API_TOKEN  - Cloudflare API Token
 *   CLOUDFLARE_ACCOUNT_ID - Cloudflare Account ID
 *   RESOURCE_PREFIX       - 资源名前缀（可选，默认空）
 * 
 * 使用方式: node deploy/worker/generate-toml.js
 */

import { writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const outputPath = join(__dirname, 'wrangler.toml');

const WORKER_NAME = 'cloudflare-imgbed';
const prefix = process.env.RESOURCE_PREFIX || '';
const KV_NAMESPACE = `${prefix}img_url`;
const R2_BUCKET = `${prefix}img_r2`;

const CF_API_BASE = 'https://api.cloudflare.com/client/v4';

/**
 * 调用 Cloudflare API
 */
async function cfApi(method, path, body = null) {
    const url = `${CF_API_BASE}${path}`;
    const options = {
        method,
        headers: {
            'Authorization': `Bearer ${process.env.CLOUDFLARE_API_TOKEN}`,
            'Content-Type': 'application/json',
        },
    };
    if (body) {
        options.body = JSON.stringify(body);
    }

    const response = await fetch(url, options);
    const data = await response.json();

    if (!data.success) {
        const errors = data.errors?.map(e => e.message).join(', ') || 'Unknown error';
        throw new Error(`API error: ${errors}`);
    }

    return data.result;
}

/**
 * 获取或创建 KV 命名空间
 */
async function ensureKVNamespace(name, accountId) {
    console.log(`\n[KV] Ensuring namespace "${name}"...`);

    // 获取所有 KV 命名空间
    const namespaces = await cfApi('GET', `/accounts/${accountId}/storage/kv/namespaces`);
    const existing = namespaces.find(n => n.title === name);

    if (existing) {
        console.log(`  Found existing KV namespace: ${existing.id}`);
        return existing.id;
    }

    // 创建新的 KV 命名空间
    console.log(`  Namespace "${name}" not found, creating...`);
    const result = await cfApi('POST', `/accounts/${accountId}/storage/kv/namespaces`, {
        title: name,
    });
    console.log(`  Created KV namespace "${name}" with id: ${result.id}`);
    return result.id;
}

/**
 * 获取或创建 R2 存储桶
 */
async function ensureR2Bucket(name, accountId) {
    console.log(`\n[R2] Ensuring bucket "${name}"...`);

    let buckets = [];
    try {
        // 列出所有 R2 存储桶，检查是否已存在
        console.log(`  [DEBUG] Fetching R2 bucket list via API...`);
        const result = await cfApi('GET', `/accounts/${accountId}/r2/buckets`);
        console.log(`  [DEBUG] R2 API response type: ${typeof result}, isArray: ${Array.isArray(result)}`);
        buckets = Array.isArray(result) ? result : (result.buckets || []);
        console.log(`  [DEBUG] Found ${buckets.length} existing R2 buckets`);
        
        const existing = buckets.find(b => b.name === name);
        if (existing) {
            console.log(`  Found existing R2 bucket: ${name}`);
            return true;
        }
        console.log(`  Bucket "${name}" not in list`);
    } catch (error) {
        console.log(`  Warning: Could not list R2 buckets: ${error.message}`);
    }

    // 桶不存在，创建新桶
    console.log(`  Creating R2 bucket "${name}"...`);
    try {
        console.log(`  [DEBUG] POST /accounts/${accountId}/r2/buckets`);
        const createResult = await cfApi('POST', `/accounts/${accountId}/r2/buckets`, {
            name: name,
        });
        console.log(`  [DEBUG] Create result:`, JSON.stringify(createResult));
        console.log(`  ✅ Created R2 bucket "${name}"`);
        return true;
    } catch (createError) {
        console.error(`  ❌ Failed to create R2 bucket: ${createError.message}`);
        // Try wrangler CLI as primary fallback for R2 creation
        // (Cloudflare R2 API sometimes requires specific permissions that wrangler handles)
        console.log(`  Trying wrangler CLI to create R2 bucket...`);
        try {
            const { execSync } = await import('child_process');
            execSync(`npx wrangler r2 bucket create "${name}"`, {
                encoding: 'utf-8',
                timeout: 30000,
                stdio: 'inherit',
            });
            console.log(`  ✅ Created R2 bucket "${name}" via wrangler`);
            return true;
        } catch (wranglerError) {
            console.error(`  ❌ wrangler fallback also failed: ${wranglerError.message}`);
            return false;
        }
    }
}

// ==================== 主流程 ====================

async function main() {
    console.log('=== Cloudflare ImgBed Deployment Config Generator ===');
    console.log(`Worker name: ${WORKER_NAME}`);
    console.log(`KV namespace: ${KV_NAMESPACE}`);
    console.log(`R2 bucket: ${R2_BUCKET}`);

    const apiToken = process.env.CLOUDFLARE_API_TOKEN;
    const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;

    if (!apiToken || !accountId) {
        console.log('\n⚠ CLOUDFLARE_API_TOKEN or CLOUDFLARE_ACCOUNT_ID not set.');
        console.log('  Skipping resource auto-creation. Generating minimal wrangler.toml.');
        generateToml(WORKER_NAME, null, null);
        return;
    }

    let kvId = null;
    let r2Created = false;

    try {
        // 1. 确保 KV 命名空间存在
        kvId = await ensureKVNamespace(KV_NAMESPACE, accountId);
        console.log(`  ✅ KV namespace ready: ${kvId}`);
    } catch (error) {
        console.error(`\n✗ Failed to setup KV namespace: ${error.message}`);
        console.log('  Continuing with minimal config...');
    }

    try {
        // 2. 确保 R2 存储桶存在
        r2Created = await ensureR2Bucket(R2_BUCKET, accountId);
        if (r2Created) {
            console.log(`  ✅ R2 bucket ready: ${R2_BUCKET}`);
        }
    } catch (error) {
        console.error(`\n✗ Failed to setup R2 bucket: ${error.message}`);
        console.log('  Continuing without R2...');
    }

    // 3. 生成 wrangler.toml
    console.log('\n[Config] Generating wrangler.toml...');
    generateToml(WORKER_NAME, kvId, r2Created ? R2_BUCKET : null);
    console.log('Done!');
}

function generateToml(name, kvId, r2Bucket) {
    const workerName = name || WORKER_NAME;

    let toml = `name = "${workerName}"
main = "index.js"
compatibility_date = "2024-08-21"
compatibility_flags = ["nodejs_compat"]

[assets]
directory = "../../frontend-dist"
binding = "ASSETS"
not_found_handling = "single-page-application"
`;

    if (kvId) {
        toml += `
[[kv_namespaces]]
binding = "img_url"
id = "${kvId}"
`;
    }

    if (r2Bucket) {
        toml += `
[[r2_buckets]]
binding = "img_r2"
bucket_name = "${r2Bucket}"
`;
    }

    writeFileSync(outputPath, toml, 'utf8');

    // 打印配置（隐藏敏感值）
    const safeToml = toml
        .replace(/(id = )".*"/g, '$1"***"');
    console.log('\nGenerated deploy/worker/wrangler.toml:');
    console.log(safeToml);
}

main().catch(error => {
    console.error('\n✗ Fatal error:', error.message);
    console.log('  Generating minimal wrangler.toml...');
    generateToml(WORKER_NAME, null, null);
    process.exit(1);
});