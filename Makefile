# Default commands (use npx so no global install required)
VSCE ?= npx @vscode/vsce
OVSX ?= npx ovsx

.PHONY: install build watch clean package publish publish-patch publish-minor publish-major publish-ovsx version

install:
	npm install

build:
	npm run compile

watch:
	npm run watch

clean:
	rm -rf out node_modules *.vsix

package: install build
	$(VSCE) package

# Bump version and publish in one go (runs npm version then vsce publish)
publish-patch: install build
	npm version patch
	$(VSCE) publish

publish-minor: install build
	npm version minor
	$(VSCE) publish

publish-major: install build
	npm version major
	$(VSCE) publish

# Publish without bumping (expects version already updated)
publish: install build
	$(VSCE) publish

# Optional: publish to Open VSX marketplace (requires OVSX_PAT environment variable)
publish-ovsx: install build
	$(OVSX) publish -p $$OVSX_PAT

