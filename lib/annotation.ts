/*
 * Copyright © 2020 Atomist, Inc.
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

import * as _ from "lodash";

const Matchers = [
	{
		name: "javac",
		severity: "error",
		pattern: [
			{
				regexp: "(.*):([0-9]+):\\s(error|warning):\\s(.*)",
				groups: {
					path: 1,
					line: 2,
					severity: 3,
					message: 4,
				},
			},
		],
	},
];

export interface Annotation {
	path: string;
	line: number;
	column: number;
	severity: "failure" | "notice" | "warning";
	title: string;
	message: string;
}

export function extractAnnotations(lines: string): Annotation[] {
	const logs = lines.split("\n");
	const annotations = [];
	for (const matcher of Matchers) {
		for (const pattern of matcher.pattern) {
			for (const l of logs) {
				const match = new RegExp(pattern.regexp, "g").exec(l.trim());
				if (match) {
					annotations.push({
						match: match[0],
						path: match[pattern.groups.path],
						line: match[pattern.groups.line],
						column: 0,
						severity:
							match[pattern.groups.severity] === "warning"
								? "warning"
								: "failure",
						message: match[pattern.groups.message],
					});
				}
			}
		}
	}
	return _.uniqBy(annotations, "match");
}
