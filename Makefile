
publish:
	pnpm run build
	pnpm version patch
	pnpm publish --access public
	git push --tags
