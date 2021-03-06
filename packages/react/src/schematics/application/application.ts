import { join, JsonObject, normalize, Path } from '@angular-devkit/core';
import {
  apply,
  chain,
  externalSchematic,
  filter,
  mergeWith,
  move,
  noop,
  Rule,
  SchematicContext,
  template,
  Tree,
  url,
} from '@angular-devkit/schematics';
import {
  addLintFiles,
  formatFiles,
  generateProjectLint,
  insert,
  names,
  NxJson,
  offsetFromRoot,
  toFileName,
  updateJsonInTree,
  updateWorkspace,
} from '@nrwl/workspace';
import {
  addDepsToPackageJson,
  appsDir,
  updateWorkspaceInTree,
} from '@nrwl/workspace/src/utils/ast-utils';
import { toJS } from '@nrwl/workspace/src/utils/rules/to-js';
import * as ts from 'typescript';
import { assertValidStyle } from '../../utils/assertion';
import { addInitialRoutes } from '../../utils/ast-utils';
import { updateJestConfigContent } from '../../utils/jest-utils';
import { extraEslintDependencies, reactEslintJson } from '../../utils/lint';
import { CSS_IN_JS_DEPENDENCIES } from '../../utils/styled';
import {
  reactRouterDomVersion,
  typesReactRouterDomVersion,
} from '../../utils/versions';
import init from '../init/init';
import { Schema } from './schema';

interface NormalizedSchema extends Schema {
  projectName: string;
  appProjectRoot: Path;
  e2eProjectName: string;
  parsedTags: string[];
  fileName: string;
  styledModule: null | string;
  hasStyles: boolean;
}

export default function (schema: Schema): Rule {
  return (host: Tree, context: SchematicContext) => {
    const options = normalizeOptions(host, schema);

    return chain([
      init({
        ...options,
        skipFormat: true,
      }),
      addLintFiles(options.appProjectRoot, options.linter, {
        localConfig: reactEslintJson,
        extraPackageDeps: extraEslintDependencies,
      }),
      createApplicationFiles(options),
      updateNxJson(options),
      addProject(options),
      addCypress(options),
      addJest(options),
      updateJestConfig(options),
      addStyledModuleDependencies(options),
      addRouting(options, context),
      setDefaults(options),
      formatFiles(options),
    ]);
  };
}

function createApplicationFiles(options: NormalizedSchema): Rule {
  return mergeWith(
    apply(url(`./files/app`), [
      template({
        ...names(options.name),
        ...options,
        tmpl: '',
        offsetFromRoot: offsetFromRoot(options.appProjectRoot),
      }),
      options.styledModule || !options.hasStyles
        ? filter((file) => !file.endsWith(`.${options.style}`))
        : noop(),
      options.unitTestRunner === 'none'
        ? filter((file) => file !== `/src/app/${options.fileName}.spec.tsx`)
        : noop(),
      move(options.appProjectRoot),
      options.js ? toJS() : noop(),
    ])
  );
}

function updateJestConfig(options: NormalizedSchema): Rule {
  return options.unitTestRunner === 'none'
    ? noop()
    : (host) => {
        const configPath = `${options.appProjectRoot}/jest.config.js`;
        const originalContent = host.read(configPath).toString();
        const content = updateJestConfigContent(originalContent);
        host.overwrite(configPath, content);
      };
}

function updateNxJson(options: NormalizedSchema): Rule {
  return updateJsonInTree<NxJson>('nx.json', (json) => {
    json.projects[options.projectName] = { tags: options.parsedTags };
    return json;
  });
}

function addProject(options: NormalizedSchema): Rule {
  return updateWorkspaceInTree((json) => {
    const architect: { [key: string]: any } = {};

    architect.build = {
      builder: '@nrwl/web:build',
      options: {
        outputPath: join(normalize('dist'), options.appProjectRoot),
        index: join(options.appProjectRoot, 'src/index.html'),
        main: join(options.appProjectRoot, maybeJs(options, `src/main.tsx`)),
        polyfills: join(
          options.appProjectRoot,
          maybeJs(options, 'src/polyfills.ts')
        ),
        tsConfig: join(options.appProjectRoot, 'tsconfig.app.json'),
        assets: [
          join(options.appProjectRoot, 'src/favicon.ico'),
          join(options.appProjectRoot, 'src/assets'),
        ],
        styles:
          options.styledModule || !options.hasStyles
            ? []
            : [join(options.appProjectRoot, `src/styles.${options.style}`)],
        scripts: [],
        webpackConfig: '@nrwl/react/plugins/webpack',
      },
      configurations: {
        production: {
          fileReplacements: [
            {
              replace: join(
                options.appProjectRoot,
                maybeJs(options, `src/environments/environment.ts`)
              ),
              with: join(
                options.appProjectRoot,
                maybeJs(options, `src/environments/environment.prod.ts`)
              ),
            },
          ],
          optimization: true,
          outputHashing: 'all',
          sourceMap: false,
          extractCss: true,
          namedChunks: false,
          extractLicenses: true,
          vendorChunk: false,
          budgets: [
            {
              type: 'initial',
              maximumWarning: '2mb',
              maximumError: '5mb',
            },
          ],
        },
      },
    };

    architect.serve = {
      builder: '@nrwl/web:dev-server',
      options: {
        buildTarget: `${options.projectName}:build`,
      },
      configurations: {
        production: {
          buildTarget: `${options.projectName}:build:production`,
        },
      },
    };

    architect.lint = generateProjectLint(
      normalize(options.appProjectRoot),
      join(normalize(options.appProjectRoot), 'tsconfig.app.json'),
      options.linter
    );

    json.projects[options.projectName] = {
      root: options.appProjectRoot,
      sourceRoot: join(options.appProjectRoot, 'src'),
      projectType: 'application',
      schematics: {},
      architect,
    };

    json.defaultProject = json.defaultProject || options.projectName;

    return json;
  });
}

function addCypress(options: NormalizedSchema): Rule {
  return options.e2eTestRunner === 'cypress'
    ? externalSchematic('@nrwl/cypress', 'cypress-project', {
        ...options,
        name: options.name + '-e2e',
        directory: options.directory,
        project: options.projectName,
      })
    : noop();
}

function addJest(options: NormalizedSchema): Rule {
  return options.unitTestRunner === 'jest'
    ? externalSchematic('@nrwl/jest', 'jest-project', {
        project: options.projectName,
        supportTsx: true,
        skipSerializers: true,
        setupFile: 'none',
        babelJest: options.babelJest,
      })
    : noop();
}

function addStyledModuleDependencies(options: NormalizedSchema): Rule {
  const extraDependencies = CSS_IN_JS_DEPENDENCIES[options.styledModule];

  return extraDependencies
    ? addDepsToPackageJson(
        extraDependencies.dependencies,
        extraDependencies.devDependencies
      )
    : noop();
}

function addRouting(
  options: NormalizedSchema,
  context: SchematicContext
): Rule {
  return options.routing
    ? chain([
        function addRouterToComponent(host: Tree) {
          const appPath = join(
            options.appProjectRoot,
            maybeJs(options, `src/app/${options.fileName}.tsx`)
          );
          const appFileContent = host.read(appPath).toString('utf-8');
          const appSource = ts.createSourceFile(
            appPath,
            appFileContent,
            ts.ScriptTarget.Latest,
            true
          );

          insert(host, appPath, addInitialRoutes(appPath, appSource, context));
        },
        addDepsToPackageJson(
          { 'react-router-dom': reactRouterDomVersion },
          { '@types/react-router-dom': typesReactRouterDomVersion }
        ),
      ])
    : noop();
}

function setDefaults(options: NormalizedSchema): Rule {
  return options.skipWorkspaceJson
    ? noop()
    : updateWorkspace((workspace) => {
        workspace.extensions.schematics = jsonIdentity(
          workspace.extensions.schematics || {}
        );
        workspace.extensions.schematics['@nrwl/react'] =
          workspace.extensions.schematics['@nrwl/react'] || {};
        const prev = jsonIdentity(
          workspace.extensions.schematics['@nrwl/react']
        );

        workspace.extensions.schematics = {
          ...workspace.extensions.schematics,
          '@nrwl/react': {
            ...prev,
            application: {
              style: options.style,
              linter: options.linter,
              ...jsonIdentity(prev.application),
            },
            component: {
              style: options.style,
              ...jsonIdentity(prev.component),
            },
            library: {
              style: options.style,
              linter: options.linter,
              ...jsonIdentity(prev.library),
            },
          },
        };
      });
}

function jsonIdentity(x: any): JsonObject {
  return x as JsonObject;
}

function normalizeOptions(host: Tree, options: Schema): NormalizedSchema {
  const appDirectory = options.directory
    ? `${toFileName(options.directory)}/${toFileName(options.name)}`
    : toFileName(options.name);

  const appProjectName = appDirectory.replace(new RegExp('/', 'g'), '-');
  const e2eProjectName = `${appProjectName}-e2e`;

  const appProjectRoot = normalize(`${appsDir(host)}/${appDirectory}`);

  const parsedTags = options.tags
    ? options.tags.split(',').map((s) => s.trim())
    : [];

  const fileName = options.pascalCaseFiles ? 'App' : 'app';

  const styledModule = /^(css|scss|less|styl|none)$/.test(options.style)
    ? null
    : options.style;

  assertValidStyle(options.style);

  return {
    ...options,
    name: toFileName(options.name),
    projectName: appProjectName,
    appProjectRoot,
    e2eProjectName,
    parsedTags,
    fileName,
    styledModule,
    hasStyles: options.style !== 'none',
  };
}

function maybeJs(options: NormalizedSchema, path: string): string {
  return options.js && (path.endsWith('.ts') || path.endsWith('.tsx'))
    ? path.replace(/\.tsx?$/, '.js')
    : path;
}
