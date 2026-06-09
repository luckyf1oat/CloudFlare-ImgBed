/**
 * 自动创建 Cloudflare 资源并生成 wrangler.toml
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

import { execSync } from 'child_process';
import { writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const outputPath = join(__dirname, 'wrangler.toml');

const WORKER_NAME = 'cloudflare-imgbed';
const prefix = process.env.RESOURCE_PREFIX || '';
const KV_NAMESPACE = `${prefix}img_url`;
const R2_BUCKET = `${prefix}img_r2`;

/**
 * 执行 wrangler 命令并返回输出
 */
function runWrangler(args) {
    try {
        const output = execSync(`npx wrangler ${args} --format json 2>&1`, {
            encoding: 'utf-8',
            timeout: 30000,
        });
        return output.trim();
    } catch (error) {
        console.error(`wrangler ${args} failed:`, error.message);
        return '';
    }
}

/**
 * 解析 wrangler 的 JSON 输出（兼容不同命令的输出格式）
 */
function parseJsonOutput(output) {
    if (!output) return null;
    // 找到第一个 { 到最后一个 }
    const start = output.indexOf('{');
    const end = output.lastIndexOf('}');
    if (start === -1 || end === -1) return null;
    try {
        return JSON.parse(output.slice(start, end + 1));
    } catch {
        return null;
    }
}

/**
 * 获取所有 KV 命名空间列表
 */
function listKVNamespaces() {
    const output = runWrangler('kv namespace list');
    if (!output) return [];
    // wrangler 输出可能是 JSON 数组或包含额外文本
    try {
        const json = output.trim();
        return JSON.parse(json);
    } catch {
        return [];
    }
}

/**
 * 创建 KV 命名空间
 */
function createKVNamespace(name) {
    const output = runWrangler(`kv namespace create "${name}"`);
    const result = parseJsonOutput(output);
    if (result && result.id) {
        console.log(`  Created KV namespace "${name}" with id: ${result.id}`);
        return result.id;
    }
    return null;
}

/**
 * 获取或创建 KV 命名空间
 */
function ensureKVNamespace(name) {
    console.log(`\n[KV] Ensuring namespace "${name}"...`);
    const namespaces = listKVNamespaces();
    const existing = namespaces.find(n => n.title === name);
    if (existing) {
        console.log(`  Found existing KV namespace: ${existing.id}`);
        return existing.id;
    }
    console.log(`  Namespace "${name}" not found, creating...`);
    return createKVNamespace(name);
}

/**
 * 获取所有 R2 存储桶列表（通过 wrangler 输出）
 */
function listR2Buckets() {
    const output = runWrangler('r2 bucket list');
    if (!output) return [];
    try {
        const json = output.trim();
        if (Array.isArray(JSON.parse(json))) {
            return JSON.parse(json);
        }
        return [];
    } catch {
        return [];
    }
}

/**
 * 创建 R2 存储桶
 */
function createR2Bucket(name) {
    try {
        execSync(`npx wrangler r2 bucket create "${name}" 2>&1`, {
            encoding: 'utf-8',
            timeout: 30000,
        });
        console.log(`  Created R2 bucket "${name}"`);
        return true;
    } catch (error) {
        console.error(`  Failed to create R2 bucket: ${error.message}`);
        return false;
    }
}

/**
 * 确保 R2 存储桶存在
 */
function ensureR2Bucket(name) {
    console.log(`\n[R2] Ensuring bucket "${name}"...`);
    const buckets = listR2Buckets();
    const existing = buckets.find(b => b.name === name);
    if (existing) {
        console.log(`  Found existing R2 bucket: ${name}`);
        return true;
    }
    console.log(`  Bucket "${name}" not found, creating...`);
    return createR2Bucket(name);
}

// ==================== 主流程 ====================

console.log('=== Cloudflare ImgBed Deployment Config Generator ===');
console.log(`Worker name: ${WORKER_NAME}`);
console.log(`KV namespace: ${KV_NAMESPACE}`);
console.log(`R2 bucket: ${R2_BUCKET}`);

const apiToken = process.env.CLOUDFLARE_API_TOKEN;
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;

if (!apiToken || !accountId) {
    console.log('\n⚠ CLOUDFLARE_API_TOKEN or CLOUDFLARE_ACCOUNT_ID not set.');
    console.log('  Skipping resource auto-creation. Using manual bindings from wrangler.toml template.');
    // 生成只包含基础配置的 toml（不含绑定）
    generateToml(null, null, null);
    process.exit(0);
}

// 1. 确保 KV 命名空间存在
const kvId = ensureKVNamespace(KV_NAMESPACE);

// 2. 确保 R2 存储桶存在
const r2Created = ensureR2Bucket(R2_BUCKET);

// 3. 生成 wrangler.toml
if (kvId || process.env.VITE_CI) {
    console.log('\n[Config] Generating wrangler.toml...');
    generateToml(WORKER_NAME, kvId, R2_BUCKET);
    console.log('Done!');
} else {
    console.error('\n✗ Failed to create KV namespace. Deployment may fail.');
    process.exit(1);
}

/**
 * 生成 wrangler.toml
 */
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