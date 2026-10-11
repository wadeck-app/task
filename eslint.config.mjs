import eslint from '@eslint/js';
import prettierConfig from 'eslint-config-prettier';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
	{
		ignores: [
			'**/dist/**',
			'**/dist-types/**',
			'**/dist-bundle/**',
			'**/node_modules/**',
			'**/coverage/**',
			'**/*.d.ts',
			'**/ci/**',
			'scripts/**',
			'*.config.mjs',
			'*.config.ts',
		],
	},
	eslint.configs.recommended,
	...tseslint.configs.recommended,
	{
		files: ['packages/*/src/**/*.ts'],
		languageOptions: {
			parser: tseslint.parser,
			parserOptions: {
				ecmaVersion: 2022,
				sourceType: 'module',
				tsconfigRootDir: import.meta.dirname,
				projectService: false,
			},
			globals: {
				...globals.node,
			},
		},
		rules: {
			'@typescript-eslint/consistent-type-imports': [
				'error',
				{
					prefer: 'type-imports',
					fixStyle: 'separate-type-imports',
					disallowTypeAnnotations: false,
				},
			],
			'@typescript-eslint/no-explicit-any': 'warn',
			'@typescript-eslint/explicit-function-return-type': 'off',
			'@typescript-eslint/no-unused-vars': [
				'warn',
				{
					argsIgnorePattern: '^_',
					varsIgnorePattern: '^_',
					caughtErrorsIgnorePattern: '^_',
					destructuredArrayIgnorePattern: '^_',
				},
			],
			'@typescript-eslint/no-unsafe-function-type': 'off',
			'@typescript-eslint/no-empty-object-type': 'off',
			'@typescript-eslint/no-require-imports': 'off',
			'@typescript-eslint/no-this-alias': 'off',
			'no-case-declarations': 'off',
			'no-console': 'off',
			'no-restricted-syntax': [
				'error',
				{
					selector: 'ExportAllDeclaration',
					message: 'export * is forbidden. Use explicit named exports instead.',
				},
			],
		},
	},
	{
		files: ['packages/*/src/**/*.test.ts', 'packages/*/src/**/*.spec.ts'],
		rules: {
			'@typescript-eslint/no-explicit-any': 'off',
			'@typescript-eslint/no-unused-vars': 'off',
		},
	},
	prettierConfig
);
