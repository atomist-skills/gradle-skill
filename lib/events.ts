/*
 * Copyright © 2021 Atomist, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {
	childProcess,
	EventContext,
	EventHandler,
	github,
	log,
	project,
	repository,
	runSteps,
	secret,
	status,
	Step,
	subscription,
} from "@atomist/skill";
import * as fs from "fs-extra";

import { extractAnnotations } from "./annotation";
import { tokenizeArgString } from "./args";
import { Configuration } from "./configuration";
import { eventCommit, eventRepo } from "./git";
import { spawnFailure, statusReason, trimDirectory } from "./status";

interface GradleParameters {
	project: project.Project;
	check: github.Check;
	body: string[];
}

type GradleStep = Step<
	EventContext<
		| subscription.types.OnPushSubscription
		| subscription.types.OnTagSubscription,
		Configuration
	>,
	GradleParameters
>;

const LoadProjectStep: GradleStep = {
	name: "load",
	run: async (ctx, params) => {
		const repo = eventRepo(ctx.data);

		const credential = await ctx.credential.resolve(
			secret.gitHubAppToken({
				owner: repo.owner,
				repo: repo.name,
				apiUrl: repo.org.provider.apiUrl,
			}),
		);

		const project: project.Project = await ctx.project.load(
			repository.gitHub({
				owner: repo.owner,
				repo: repo.name,
				credential,
			}),
			process.cwd(),
		);
		// const project: project.Project = await ctx.project.clone(
		// 	repository.gitHub({
		// 		owner: repo.owner,
		// 		repo: repo.name,
		// 		credential,
		// 	}),
		// );
		params.project = project;

		return status.success();
	},
};

const ValidateStep: GradleStep = {
	name: "validate",
	run: async (ctx, params) => {
		if (!(await fs.pathExists(params.project.path("build.gradle")))) {
			return status
				.success(`Ignoring push to non-Gradle project`)
				.hidden()
				.abort();
		}

		// raise the check
		if (ctx.configuration?.parameters?.check) {
			const commit = eventCommit(ctx.data);
			params.check = await github.createCheck(ctx, params.project.id, {
				sha: commit.sha,
				title: "gradle",
				name: `${ctx.skill.name}/${ctx.configuration?.name}`,
				body: "Running Gradle build",
			});
		}
		params.body = [];

		return status.success();
	},
};

const CommandStep: GradleStep = {
	name: "command",
	runWhen: async ctx => !!ctx.configuration?.parameters?.command,
	run: async (ctx, params) => {
		const repo = eventRepo(ctx.data);
		const commit = eventCommit(ctx.data);
		const result = await childProcess.spawnPromise(
			"bash",
			["-c", ctx.configuration.parameters.command],
			{ log: childProcess.captureLog(log.info) },
		);
		if (result.status !== 0) {
			params.body.push(spawnFailure(result));
			await params.check?.update({
				conclusion: "failure",
				body: params.body.join("\n\n---\n\n"),
			});
			return status.failure(
				statusReason({
					reason: `\`${result.cmdString}\` failed`,
					repo,
					commit,
				}),
			);
		}
		params.body.push(
			`Setup command \`${trimDirectory(result.cmdString)}\` successful`,
		);
		await params.check?.update({
			conclusion: undefined,
			body: params.body.join("\n\n---\n\n"),
		});
		return status.success();
	},
};

const PrepareStep: GradleStep = {
	name: "prepare",
	runWhen: async ctx => !!ctx.configuration?.parameters?.settings,
	run: async (ctx, params) => {
		const cfg = ctx.configuration.parameters;
		await fs.ensureDir(params.project.path(".gradle"));
		await fs.writeFile(
			params.project.path(".gradle", "gradle.properties"),
			cfg.settings,
		);

		await params.check?.update({
			conclusion: undefined,
			body: params.body.join("\n\n---\n\n"),
		});
		return status.success();
	},
};

const SetupNodeStep: GradleStep = {
	name: "setup jdk",
	run: async (ctx, params) => {
		const repo = eventRepo(ctx.data);
		const commit = eventCommit(ctx.data);
		const cfg = ctx.configuration?.parameters;
		// Set up jdk
		const result = await params.project.spawn(
			"bash",
			[
				"-c",
				`source $SDKMAN_DIR/bin/sdkman-init.sh && sdk install java ${cfg.version}`,
			],
			{ level: "info" },
		);
		if (result.status !== 0) {
			params.body.push(spawnFailure(result));
			await params.check?.update({
				conclusion: "failure",
				body: params.body.join("\n\n---\n\n"),
			});
			return status.failure(
				statusReason({
					reason: `\`${result.cmdString}\` failed`,
					repo,
					commit,
				}),
			);
		}

		params.body.push(`Installed JDK version \`${cfg.version}\``);
		await params.check?.update({
			conclusion: undefined,
			body: params.body.join("\n\n---\n\n"),
		});
		return status.success();
	},
};

const GradleGoalsStep: GradleStep = {
	name: "gradle",
	run: async (ctx, params) => {
		const repo = eventRepo(ctx.data);
		const commit = eventCommit(ctx.data);
		const cfg = ctx.configuration?.parameters;
		let args = tokenizeArgString(cfg.gradle || "build");
		let command = (await fs.pathExists(params.project.path("gradlew")))
			? "./gradlew"
			: "gradle";

		// Deal with user provided command in the args parameter
		if (args[0] === "gradle" || args[0] === "./gradlew") {
			command = args[0];
			args = args.slice(1);
		}

		// Run gradle
		const resultLog = childProcess.captureLog(log.info);
		const result = await params.project.spawn(
			"bash",
			["-c", [command, ...args].join(" ")],
			{
				env: {
					...process.env,
					JAVA_HOME: "/opt/.sdkman/candidates/java/current",
					PATH: `/opt/.sdkman/candidates/gradle/current/bin:/opt/.sdkman/candidates/java/current/bin:${process.env.PATH}`,
				},
				log: resultLog,
				logCommand: false,
			},
		);
		const annotations = extractAnnotations(resultLog.log);
		if (result.status !== 0 || annotations.length > 0) {
			const home = process.env.ATOMIST_HOME || "/atm/home";
			result.stderr = resultLog.log;
			params.body.push(spawnFailure(result));
			await params.check?.update({
				conclusion: "failure",
				body: params.body.join("\n\n---\n\n"),
				annotations: annotations.map(r => ({
					annotationLevel: r.severity,
					path: r.path.replace(home + "/", ""),
					startLine: r.line ? +r.line : undefined,
					endLine: r.line ? +r.line : undefined,
					startOffset: r.column ? +r.column : undefined,
					title: r.title,
					message: r.message,
				})),
			});
			return status.failure(
				statusReason({
					reason: `\`${result.cmdString}\` failed`,
					commit,
					repo,
				}),
			);
		}
		params.body.push(`\`${trimDirectory(result.cmdString)}\` successful`);
		await params.check?.update({
			conclusion: "success",
			body: params.body.join("\n\n---\n\n"),
		});
		return status.success(
			statusReason({
				reason: `Gradle build succeeded`,
				commit,
				repo,
			}),
		);
	},
};

export const handler: EventHandler<
	| subscription.types.OnPushSubscription
	| subscription.types.OnTagSubscription,
	Configuration
> = async ctx =>
	runSteps({
		context: ctx,
		steps: [
			LoadProjectStep,
			ValidateStep,
			CommandStep,
			PrepareStep,
			SetupNodeStep,
			GradleGoalsStep,
		],
		parameters: { body: [] },
	});
