import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  b2ContentStoreConfigFromEnvironment,
  contentStoreFromEnvironment,
} from "./content-store.js";

type B2EnvironmentName =
  | "B2_ACCESS_KEY_ID"
  | "B2_SECRET_ACCESS_KEY"
  | "B2_REGION"
  | "B2_BUCKET"
  | "B2_ENDPOINT";

const environmentNames: B2EnvironmentName[] = [
  "B2_ACCESS_KEY_ID",
  "B2_SECRET_ACCESS_KEY",
  "B2_REGION",
  "B2_BUCKET",
  "B2_ENDPOINT",
];

const requiredEnvironmentNames = environmentNames.slice(0, 4);

function setCompleteEnvironment(): void {
  process.env.B2_ACCESS_KEY_ID = "access-key";
  process.env.B2_SECRET_ACCESS_KEY = "secret-key";
  process.env.B2_REGION = "us-west-004";
  process.env.B2_BUCKET = "media-bucket";
}

describe("content store environment", () => {
  let environmentSnapshot: Array<[B2EnvironmentName, string | undefined]>;

  beforeEach(() => {
    environmentSnapshot = environmentNames.map((name) => [name, process.env[name]]);
    for (const name of environmentNames) delete process.env[name];
  });

  afterEach(() => {
    for (const [name, value] of environmentSnapshot) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  });

  it.each(requiredEnvironmentNames)("requires %s", (missingName) => {
    setCompleteEnvironment();
    delete process.env[missingName];

    expect(b2ContentStoreConfigFromEnvironment()).toBeUndefined();
    expect(contentStoreFromEnvironment()).toBeUndefined();
  });

  it("treats an empty required value as incomplete", () => {
    setCompleteEnvironment();
    process.env.B2_BUCKET = "";

    expect(b2ContentStoreConfigFromEnvironment()).toBeUndefined();
  });

  it("maps complete environment values and the optional endpoint", () => {
    setCompleteEnvironment();
    process.env.B2_ENDPOINT = "https://s3.us-west-004.backblazeb2.com";

    expect(b2ContentStoreConfigFromEnvironment()).toEqual({
      accessKeyId: "access-key",
      secretAccessKey: "secret-key",
      region: "us-west-004",
      bucket: "media-bucket",
      endpoint: "https://s3.us-west-004.backblazeb2.com",
    });
  });

  it("omits the endpoint when it is not configured", () => {
    setCompleteEnvironment();

    expect(b2ContentStoreConfigFromEnvironment()).toEqual({
      accessKeyId: "access-key",
      secretAccessKey: "secret-key",
      region: "us-west-004",
      bucket: "media-bucket",
    });
  });

  it("constructs a content store without making a network request", () => {
    setCompleteEnvironment();

    expect(contentStoreFromEnvironment()).toMatchObject({
      head: expect.any(Function),
      uploadFile: expect.any(Function),
      downloadFile: expect.any(Function),
      delete: expect.any(Function),
    });
  });
});
