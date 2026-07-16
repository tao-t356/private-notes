export type BrandingEnv = {
	APP_NAME?: string;
	APP_SHORT_NAME?: string;
	APP_DESCRIPTION?: string;
};

export type AppBranding = {
	name: string;
	shortName: string;
	description: string;
};

const DEFAULT_BRANDING: AppBranding = {
	name: 'Private Notes',
	shortName: '我的笔记',
	description: '一个部署在 Cloudflare Workers 上的简洁私人笔记。',
};

function normalizeBrandingValue(value: string | undefined, fallback: string, maxLength: number) {
	if (typeof value !== 'string') return fallback;
	const normalized = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
	if (!normalized) return fallback;
	return Array.from(normalized).slice(0, maxLength).join('');
}

export function getAppBranding(env: BrandingEnv): AppBranding {
	return {
		name: normalizeBrandingValue(env.APP_NAME, DEFAULT_BRANDING.name, 64),
		shortName: normalizeBrandingValue(env.APP_SHORT_NAME, DEFAULT_BRANDING.shortName, 32),
		description: normalizeBrandingValue(env.APP_DESCRIPTION, DEFAULT_BRANDING.description, 160),
	};
}

function replaceText(value: string) {
	return {
		element(element: Element) {
			element.setInnerContent(value);
		},
	};
}

function replaceAttribute(name: string, value: string) {
	return {
		element(element: Element) {
			element.setAttribute(name, value);
		},
	};
}

export function rewriteBrandedHtml(response: Response, branding: AppBranding, page: 'app' | 'share') {
	let rewriter = new HTMLRewriter()
		.on('html', {
			element(element) {
				element.setAttribute('data-app-short-name', branding.shortName);
			},
		})
		.on('.login-mini', replaceText(branding.name));

	if (page === 'app') {
		rewriter = rewriter
			.on('title', replaceText(branding.name))
			.on('meta[name="apple-mobile-web-app-title"]', replaceAttribute('content', branding.shortName))
			.on('meta[name="description"]', replaceAttribute('content', branding.description))
			.on('#loginTitle', replaceText(`正在打开${branding.shortName}`))
			.on('#topbarTitle', replaceText(branding.shortName));
	} else {
		rewriter = rewriter
			.on('title', replaceText(`一次性笔记 · ${branding.name}`))
			.on(
				'meta[name="description"]',
				replaceAttribute('content', `查看一条客户端加密、阅后即焚的 ${branding.name} 分享。`)
			);
	}

	const transformed = rewriter.transform(response);
	const headers = new Headers(transformed.headers);
	headers.delete('content-length');
	headers.delete('etag');
	return new Response(transformed.body, {
		status: transformed.status,
		statusText: transformed.statusText,
		headers,
	});
}

export function createBrandedManifest(branding: AppBranding, headOnly = false) {
	const body = JSON.stringify({
		name: branding.name,
		short_name: branding.shortName,
		description: branding.description,
		start_url: '/',
		scope: '/',
		display: 'standalone',
		background_color: '#f5f5f5',
		theme_color: '#07c160',
		lang: 'zh-CN',
		icons: [
			{
				src: '/app-icon.svg',
				sizes: 'any',
				type: 'image/svg+xml',
				purpose: 'any maskable',
			},
		],
	});

	return new Response(headOnly ? null : body, {
		headers: {
			'content-type': 'application/manifest+json; charset=utf-8',
			'cache-control': 'public, max-age=0, must-revalidate',
			'x-content-type-options': 'nosniff',
		},
	});
}
